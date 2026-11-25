const {
  EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { log }                              = require('./logger');
const store                                = require('./connectionStore');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { getUserStats, formatMs, getStreamStats }  = require('./database');
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
 * @param {string} guildId
 * @param {import('discord.js').Guild|null} guild — pass to show live member count
 */
function buildPanelEmbed(guildId, guild = null) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const isGhost   = entry && !getVoiceConnection(guildId);

  // Same RAM reading as the Discloud dashboard (see src/system.js); falls back to the process's own RSS
  const memMB     = require('./system').formatMemory();
  let colour, statusLine, channelLine, vcUptime, processUp, membersInVc;


  if (connected && entry) {
    colour      = 0x57F287;
    statusLine  = '🟢 Online';
    channelLine = entry.channelName;
    vcUptime    = store.formatUptime(entry.joinedAt);
    processUp   = getProcessUptime();

  // Live member count in the VC (excluding bots)
    if (guild) {
      const ch = guild.channels.cache.get(entry.channelId);
      const count = ch ? ch.members.filter(m => !m.user.bot).size : 0;
      membersInVc = `${count} ${count === 1 ? 'member' : 'members'}`;
    } else {
      membersInVc = '0 members';
    }

  } else if (isGhost) {
    colour      = 0xFEE75C;
    statusLine  = '🟡 Idle';
    channelLine = entry.channelName;
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0 members';
  } else {
    colour      = 0xED4245;
    statusLine  = '🔴 Offline';
    channelLine = '—';
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0 members';
  }

  const embed = new EmbedBuilder()
    .setTitle('Voice panel')
    .setColor(colour)
    .addFields(
      { name: 'Status', value: statusLine, inline: true },
      { name: 'Channel', value: channelLine, inline: true },
      { name: 'In voice', value: membersInVc, inline: true },
      { name: 'Connected for', value: vcUptime, inline: true },
      { name: 'Bot uptime', value: processUp, inline: true },
      { name: 'Memory', value: memMB, inline: true },
    )
    .setFooter({ text: 'Last updated' })
    .setTimestamp();

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

// ── Member profile embed ──────────────────────────────────────────────────────

function buildMemberEmbed(member, guild) {
  const user  = member.user;
  const stats = getUserStats(user.id, guild.id);
  const streamStats = getStreamStats(user.id, guild.id);

  let timeInServer = null;
  if (member.joinedAt) {
    const diff = Date.now() - member.joinedTimestamp;
    timeInServer = duration(diff);
  }

  const ageMs     = Date.now() - user.createdAt.getTime();
  const ageYears  = Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
  const ageMonths = Math.floor((ageMs % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
  const ageStr    = ageYears > 0 ? `${ageYears}y ${ageMonths}m` : `${ageMonths}m`;

  const nickname   = member.nickname && member.nickname !== user.username ? member.nickname : 'None';
  const boostSince = member.premiumSince;
  const boostStr   = boostSince ? `<t:${Math.floor(boostSince.getTime() / 1000)}:R>` : 'No';

  const vc = member.voice;
  const vcKey = `${guild.id}_${user.id}`;
  
  let vcLine;
  if (vc?.channel) {
    const sessionMs = joinTimes.has(vcKey) ? Date.now() - joinTimes.get(vcKey) : null;
    const indicators = [
      vc.selfMute   ? 'Muted' : null,
      vc.selfDeaf   ? 'Deafened' : null,
      vc.serverMute ? 'Server Muted' : null,
      vc.serverDeaf ? 'Server Deafened' : null
    ].filter(Boolean);

    vcLine = `<#${vc.channel.id}> ${sessionMs ? `— \`${formatLive(sessionMs)}\`` : ''}`;
    if (indicators.length > 0) vcLine += `\n${indicators.join('  •  ')}`;
  } else {
    vcLine = 'Not in a VC';
  }

  const allRoles = member.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position);
  const roles = allRoles.first(4).map(r => `<@&${r.id}>`);
  const extraRoleCount = Math.max(0, allRoles.size - 4);

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || 0x5865F2)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setTitle('User profile')
    // Section headers below use a plain bold bullet, not decorative emoji,
    // per request — just enough to visually separate each group of fields.
    .addFields({ name: '\u200b', value: '**▸ Account Overview**', inline: false })
    // Row 1: Registry Markers
    .addFields(
      { name: 'Joined server', value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>\n(<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:D>\n(<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account age', value: `\`${ageStr}\``, inline: true }
    )
    .addFields({ name: '\u200b', value: '**▸ Member Details**', inline: false })
    // Row 2: Presence Metadata
    .addFields(
      { name: 'Nickname', value: `\`${nickname}\``, inline: true },
      { name: 'Time in Server', value: `\`${timeInServer || '—'}\``, inline: true },
      { name: 'Boosting', value: boostStr, inline: true }
    )
    .addFields({ name: '\u200b', value: '**▸ Live Status**', inline: false })
    // Row 3: Live Channels
    .addFields(
      { name: 'Active VC', value: vcLine, inline: false }
    );

  // Historical Metrics
  if (stats.session_count > 0) {
    let lastSeenStr = stats.last_seen ? `<t:${Math.floor(stats.last_seen / 1000)}:R>` : '—';
    if (vc?.channel) lastSeenStr = 'Active Now';

    embed.addFields({ name: '\u200b', value: '**▸ Voice Activity**', inline: false });
    embed.addFields(
      { name: 'Total VC Time', value: `\`${formatMs(stats.total_ms)}\``, inline: true },
      { name: 'Total sessions', value: `\`${stats.session_count}\``, inline: true },
      { name: 'Avg time', value: `\`${formatMs(stats.avg_ms)}\``, inline: true },

      { name: 'Top VC', value: stats.top_channel ? `**${stats.top_channel}**\n(\`${formatMs(stats.top_channel_ms)}\`)` : '—', inline: true },
      { name: 'VC Streak', value: `\`${stats.streak} day(s)\``, inline: true },
      { name: 'Longest session', value: `\`${formatMs(stats.longest_session_ms)}\``, inline: true },

      { name: 'Last tracked', value: lastSeenStr, inline: true },
      { name: 'Longest stream', value: `\`${formatMs(streamStats.longest_stream_ms)}\``, inline: true }
    );
  }

  // Roles — capped to 4, with a "+N more" indicator instead of dumping everyone
  if (roles.length > 0) {
    embed.addFields({ name: '\u200b', value: '**▸ Roles**', inline: false });
    embed.addFields({
      name: `Assigned Roles (${allRoles.size})`,
      value: extraRoleCount > 0 ? `${roles.join(' ')} \`+${extraRoleCount} more\`` : roles.join(' '),
      inline: false,
    });
  }

  return embed.setTimestamp();
}

// ── Panel buttons ─────────────────────────────────────────────────────────────

function buildPanelButtons(guildId = null) {
  const inCall = guildId ? isConnected(guildId) : true;   // Leave is greyed out when there is nothing to leave
  // Row 1: Connection Basics
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_join')
      .setLabel('Join')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('bot_leave')
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!inCall)
  );

  // Row 2: Identity & Discovery
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_myinfo')
      .setLabel('My info')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('bot_lookup')
      .setLabel('User lookup')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Server stats
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_leaderboard')
      .setLabel('Leaderboard')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2, row3];
}

// ── Select menus ──────────────────────────────────────────────────────────────

function buildChannelSelectRow() {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('bot_join_channel')
      .setPlaceholder('Pick a voice channel to join...')
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
  );
}

function buildUserSelectRow() {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('bot_lookup_user')
      .setPlaceholder('Select a member to look up...')
  );
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
  buildChannelSelectRow,
  buildUserSelectRow,
};
