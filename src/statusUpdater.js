const {
  EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { log }                              = require('./logger');
const store                                = require('./connectionStore');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { getUserStats, formatMs }  = require('./database');
const { joinTimes }           = require('./memberTracker');
const { duration } = require('./duration');

const PRESENCE_INTERVAL  = 60 * 1000;

const HEALTHY = [
  VoiceConnectionStatus.Ready,
  VoiceConnectionStatus.Signalling,
  VoiceConnectionStatus.Connecting,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isConnected(guildId) {
  const conn = getVoiceConnection(guildId);
  return conn && HEALTHY.includes(conn.state.status);
}

const getProcessUptime = () => duration(process.uptime() * 1000);

/** Format ms with seconds — for live session durations. */
const formatLive = (ms) => duration(ms, { seconds: true });

// ── Presence ──────────────────────────────────────────────────────────────────
// The rotating status is owned by presence.js (managed by the bot owner in /owner).

function startStatusUpdater(client) {
  require('./presence').start(client);
  const panelUpdate = async () => { await updatePanel(client); };
  panelUpdate();
  setInterval(panelUpdate, PRESENCE_INTERVAL);
  log('INFO', 'Panel updater started (60s)');
}

// ── Panel embed ───────────────────────────────────────────────────────────────

/**
 * The live panel. The title is the channel the bot is in, under a small "Bot is in" label.
 * @param {string} guildId
 * @param {import('discord.js').Guild|null} guild — pass to show the live member count
 */
function buildPanelEmbed(guildId, guild = null) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const isGhost   = entry && !getVoiceConnection(guildId);
  const memory    = require('./system').formatMemory();     // same reading as the Discloud dashboard

  let colour, label, title, status, inCall = '—', inVoice = '—', reconnects = '0';
  if (connected && entry) {
    colour = 0x57F287; label = 'Bot is in'; title = entry.channelName; status = 'Online';
    inCall = duration(Date.now() - new Date(entry.joinedAt).getTime());
    const ch = guild?.channels.cache.get(entry.channelId);
    const count = ch ? ch.members.filter(m => !m.user.bot).size : 0;
    inVoice = `${count} ${count === 1 ? 'person' : 'people'}`;
    reconnects = String(entry.reconnectCount || 0);
  } else if (isGhost) {
    colour = 0xFEE75C; label = 'Bot is in'; title = entry.channelName; status = 'Idle';
  } else {
    colour = 0xED4245; label = 'Bot is'; title = 'Not in a voice channel'; status = 'Offline';
  }

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: label })
    .setTitle(title)
    .addFields(
      { name: 'Time in call', value: inCall, inline: true },
      { name: 'In the call', value: inVoice, inline: true },
      { name: 'Status', value: status, inline: true },
      { name: 'Memory', value: memory, inline: true },
      { name: 'Bot uptime', value: getProcessUptime(), inline: true },
      { name: 'Reconnects', value: reconnects, inline: true },
    )
    .setTimestamp();   // the classic embed shows its own time; a card gets an "Updated … ago" line instead

  const top = guild ? topThisWeek(guild) : null;
  if (top) embed.addFields({ name: 'Top this week', value: top, inline: false });
  return embed;
}

/** The three people with the most voice time in the last 7 days, or null when nobody has any. */
function topThisWeek(guild) {
  const rows = require('./leaderboard').totals(guild, 'week', 8)
    .map(r => ({ ...r, member: guild.members.cache.get(r.user_id) })).filter(r => r.member && !r.member.user.bot).slice(0, 3);
  if (!rows.length) return null;
  const medals = ['🥇', '🥈', '🥉'];
  return rows.map((r, i) => `${medals[i]} **${r.member.displayName}** · ${duration(Number(r.ms))}`).join('\n');
}

// ── Member card ───────────────────────────────────────────────────────────────

const dayText = (ms) => `<t:${Math.floor(ms / 1000)}:D>`;

/** A member's card: voice numbers, how long they have been around, and where they are now. `kicker` is the small label above the name. */
function buildMemberEmbed(member, guild, kicker = 'Member') {
  const user  = member.user;
  const stats = getUserStats(user.id, guild.id);

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || 0x5865F2)
    .setAuthor({ name: kicker })
    .setTitle(member.displayName)
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }));

  const fields = [];
  if (stats.session_count > 0) {
    const live = member.voice?.channel;
    fields.push(
      { name: 'Time in voice', value: formatMs(stats.total_ms), inline: true },
      { name: 'Sessions', value: String(stats.session_count), inline: true },
      { name: 'Streak', value: `${stats.streak} ${stats.streak === 1 ? 'day' : 'days'}`, inline: true },
      { name: 'Longest session', value: formatMs(stats.longest_session_ms), inline: true },
      { name: 'Average session', value: formatMs(stats.avg_ms), inline: true },
      { name: 'Last in voice', value: live ? 'In voice now' : stats.last_seen ? `<t:${Math.floor(stats.last_seen / 1000)}:R>` : '—', inline: true },
    );
    if (stats.top_channel) fields.push({ name: 'Top voice channel', value: stats.top_channel, inline: true });
  } else {
    embed.setDescription('No voice time recorded yet.');
  }
  fields.push(
    { name: 'Joined the server', value: member.joinedAt ? dayText(member.joinedTimestamp) : '—', inline: true },
    { name: 'Account created', value: dayText(user.createdTimestamp), inline: true },
  );
  const vc = member.voice?.channel;
  if (vc) {
    const since = joinTimes.get(`${guild.id}_${user.id}`);
    const flags = [member.voice.selfMute && 'muted', member.voice.selfDeaf && 'deafened', member.voice.streaming && 'live'].filter(Boolean);
    fields.push({ name: 'In voice now', value: `<#${vc.id}>${since ? ` · ${formatLive(Date.now() - since)}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`, inline: false });
  }
  const roles = member.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
  if (roles.size) fields.push({ name: `Roles (${roles.size})`, value: `${roles.first(4).map(r => `<@&${r.id}>`).join(' ')}${roles.size > 4 ? ` +${roles.size - 4} more` : ''}`, inline: false });
  return embed.addFields(fields);
}

// ── Panel buttons ─────────────────────────────────────────────────────────────

function buildPanelButtons(guildId = null) {
  const inCall = guildId ? isConnected(guildId) : true;   // Move and Leave are greyed out when there is nothing to move or leave
  const b = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  return [
    new ActionRowBuilder().addComponents(
      b('bot_join', 'Join', ButtonStyle.Success),
      b('bot_move', 'Move', ButtonStyle.Primary, !inCall),
      b('bot_leave', 'Leave', ButtonStyle.Secondary, !inCall)),
    new ActionRowBuilder().addComponents(
      b('bot_myinfo', 'My card', ButtonStyle.Primary),
      b('bot_busy', 'Busy times'),
      b('bot_recap', 'Weekly recap'),
      b('bot_leaderboard', 'Leaderboard'),
      b('bot_swrapped', 'Server Wrapped')),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('bot_more').setPlaceholder('More…').addOptions(
        { label: 'My Server Time Wrapped', value: 'mywrapped', description: 'Your year in this server' },
        { label: 'User lookup', value: 'lookup', description: "See another member's card" })),
  ];
}

// ── Update panel ──────────────────────────────────────────────────────────────

async function updatePanel(client) {
  client.guilds.cache.forEach(async (guild) => {
    const config = getGuildConfig(guild.id);
    
    // SAFETY FIX: Prevents your bot from crashing if a server hasn't built a status panel yet
    if (!config || !config.panelChannelId || !config.panelMessageId) return;

    try {
      const channel = await client.channels.fetch(config.panelChannelId);
      if (!channel || !channel.isTextBased()) return;

      const message = await channel.messages.fetch(config.panelMessageId);
      if (!message) return;

      // Pass down the real synchronization data directly to the dashboard grid
      const updatedEmbed = buildPanelEmbed(guild.id, guild);
      // `liveStamp`: as a card the panel carries an "Updated … ago" line that Discord keeps counting
      const payload = { embeds: [updatedEmbed], components: buildPanelButtons(guild.id), liveStamp: true };
      const repostMs = (Number(config.panelRepostMinutes) || 0) * 60000;
      if (repostMs && Date.now() - message.createdTimestamp >= repostMs) {
        // staff chose to delete and post again: the new message's sent time is the freshness stamp
        const fresh = await channel.send(payload);
        setGuildConfig(guild.id, { panelMessageId: fresh.id });
        await message.delete().catch(() => {});
        return;
      }
      await message.edit(payload);
    } catch (err) {
      log('WARN', 'Could not update panel', { guild: guild.name, err });
    }
  });
}


module.exports = {
  startStatusUpdater,
  updatePanel,
  buildPanelEmbed,
  buildPanelButtons,
  buildMemberEmbed,
};
