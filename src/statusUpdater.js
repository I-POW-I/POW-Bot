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
  const mem       = require('./system').getMemoryInfo();
  const memText   = mem.limitMb ? `${Math.round(mem.usedMb)} MB of ${Math.round(mem.limitMb)} MB` : `${Math.round(mem.usedMb)} MB`;
  const stats     = require('./panelStats');

  const GREEN = 0x57F287, AMBER = 0xFEE75C, RED = 0xED4245;
  let accent, online, channel = null, status, rows = [], more = 0, listTitle = null, inCall = '—';
  const today = guild ? stats.todayStats(guild) : { ms: 0, peak: 0, calls: 0 };

  if ((connected || isGhost) && entry) {
    channel = `🔊 ${entry.channelName}`;
    inCall = duration(Date.now() - new Date(entry.joinedAt).getTime());
  }
  if (connected && entry) {
    accent = GREEN; online = { text: 'BOT ONLINE', colour: GREEN };
    const people = guild ? stats.inCall(guild, entry.channelId) : [];
    status = { colour: GREEN, text: people.length
      ? `${people.length} in this call · running ${inCall}`
      : `Nobody else here yet · running ${inCall}` };
    rows = people.slice(0, 4).map(p => ({ avatar: p.member.displayAvatarURL({ extension: 'png', size: 64 }), name: p.member.displayName, text: duration(p.ms) }));
    more = Math.max(0, people.length - rows.length);
  } else if (isGhost) {
    accent = AMBER; online = { text: 'BOT IDLE', colour: AMBER };
    status = { colour: AMBER, text: 'Reconnecting to the call' };
  } else {
    accent = RED; online = { text: 'NOT IN A CALL', colour: RED };
    status = { colour: 0x949BA4, text: 'The bot is not in a voice channel' };
  }
  if (!rows.length && guild) {   // nobody to show: the week's top people instead
    const top = topThisWeek(guild);
    if (top.length) { listTitle = 'TOP THIS WEEK'; rows = top.map(t => ({ avatar: t.member.displayAvatarURL({ extension: 'png', size: 64 }), name: t.member.displayName, text: t.text })); more = 0; }
  }

  const brief = (ms) => duration(ms).replace(/ minutes?/, ' min');   // "11 hours 20 min": keeps the figures on one line
  const figures = [
    { name: 'Server voice today', value: brief(today.ms) },
    { name: 'Most at once today', value: `${today.peak} ${today.peak === 1 ? 'person' : 'people'}` },
    { name: 'Calls today', value: String(today.calls) },
    { name: 'Bot in call for', value: inCall === '—' ? inCall : brief(Date.now() - new Date(entry.joinedAt).getTime()) },
    { name: 'Bot memory', value: memText },
    { name: 'Bot uptime', value: brief(process.uptime() * 1000) },
  ];
  const title = guild?.name || 'Voice panel';

  // the classic embed (also the fallback when a card cannot be drawn)
  const embed = new EmbedBuilder()
    .setColor(accent)
    .setAuthor({ name: `${connected ? '🟢' : isGhost ? '🟡' : '🔴'} ${online.text[0] + online.text.slice(1).toLowerCase()}` })
    .setTitle(title)
    .setDescription([channel ? `Bot is in **${channel}**` : status.text, connected && entry ? status.text : null,
      rows.length ? `\n${listTitle ? '**Top this week**\n' : ''}${rows.map(r => `**${r.name}** · ${r.text}`).join('\n')}${more ? `\n+ ${more} more` : ''}` : null].filter(Boolean).join('\n'))
    .addFields(figures.map(f => ({ name: f.name, value: f.value, inline: true })))
    .setFooter({ text: 'Updates every minute' })
    .setTimestamp();

  // what the card draws: hidden from the embed itself, so the classic look never sends it to Discord
  Object.defineProperty(embed.data, 'panel', { enumerable: false, value: {
    accent, online, title, subtitle: guild?.description || null, channel, channelLabel: connected || isGhost ? 'Bot is in' : null,
    status, listTitle, rows, more, stats: figures, footer: 'Updates every minute',
  } });
  return embed;
}

/** The three people with the most voice time in the last 7 days. */
function topThisWeek(guild) {
  return require('./leaderboard').totals(guild, 'week', 8)
    .map(r => ({ member: guild.members.cache.get(r.user_id), ms: Number(r.ms) })).filter(r => r.member && !r.member.user.bot).slice(0, 3)
    .map(r => ({ member: r.member, text: duration(r.ms) }));
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
    const dayShort = (n) => new Date(n * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const dayNice = (iso) => dayShort(Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000));
    fields.push(
      { name: 'Time in voice', value: formatMs(stats.total_ms), inline: true },
      { name: 'Sessions', value: String(stats.session_count), inline: true },
      { name: 'Streak', value: `${stats.streak} ${stats.streak === 1 ? 'day' : 'days'}`, inline: true },
      { name: 'Longest streak', value: stats.longest_streak ? `${stats.longest_streak} ${stats.longest_streak === 1 ? 'day' : 'days'}${stats.longest_streak > 1 ? `\n${dayShort(stats.longest_streak_from)} to ${dayShort(stats.longest_streak_to)}` : ''}` : '—', inline: true },
      { name: 'Longest session', value: formatMs(stats.longest_session_ms), inline: true },
      { name: 'Last in voice', value: live ? 'In voice now' : stats.last_seen ? `<t:${Math.floor(stats.last_seen / 1000)}:R>` : '—', inline: true },
    );
    if (stats.top_channel) fields.push({ name: 'Top channel', value: stats.top_channel, inline: true });
    if (stats.busiest_day) fields.push({ name: 'Busiest day', value: `${dayNice(stats.busiest_day)}\n${formatMs(stats.busiest_day_ms)}`, inline: true });
    if (stats.stream_ms > 0) fields.push({ name: 'Time streaming', value: `${formatMs(stats.stream_ms)}\n${stats.stream_count} ${stats.stream_count === 1 ? 'stream' : 'streams'}`, inline: true });
  } else {
    embed.setDescription('No voice time recorded yet.');
  }
  fields.push(
    { name: 'Joined server', value: member.joinedAt ? dayText(member.joinedTimestamp) : '—', inline: true },
    { name: 'Account made', value: dayText(user.createdTimestamp), inline: true },
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
      b('bot_leave', 'Leave', ButtonStyle.Danger, !inCall),
      b('bot_leaderboard', 'Leaderboard'),
      b('bot_myinfo', 'My card')),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('bot_more').setPlaceholder('More…').addOptions(
        { label: 'Busy times', value: 'busy', description: 'How busy voice is now and usually' },
        { label: 'Weekly recap', value: 'recap', description: 'The last 7 days in voice' },
        { label: 'Server Wrapped', value: 'swrapped', description: "The server's year in voice and chat" },
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
