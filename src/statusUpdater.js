const {
  ActivityType, EmbedBuilder, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { log }                              = require('./logger');
const store                                = require('./connectionStore');
const { getGuildConfig, getStats, getLogChannel } = require('./guildConfig');
const { getUserStats, getServerTotals, formatMs, getStreamStats }  = require('./database');
const { joinTimes, streamTimes }           = require('./memberTracker');

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

function getProcessUptime() {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Format ms with seconds — for live session durations. */
function formatLive(ms) {
  if (!ms || ms <= 0) return '0s';
  const totalS = Math.floor(ms / 1000);
  const h   = Math.floor(totalS / 3600);
  const m   = Math.floor((totalS % 3600) / 60);
  const sec = totalS % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

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
  const memMB     = `\`${require('./system').formatMemory()}\``;
  let colour, statusLine, channelLine, vcUptime, processUp, membersInVc;


  if (connected && entry) {
    colour      = 0x57F287;
    statusLine  = 'Connected';
    channelLine = `**${entry.channelName}**`;
    vcUptime    = store.formatUptime(entry.joinedAt);
    processUp   = getProcessUptime();

  // Live member count in the VC (excluding bots)
    if (guild) {
      const ch = guild.channels.cache.get(entry.channelId);
      membersInVc = ch ? `${ch.members.filter(m => !m.user.bot).size}` : '0';
    } else {
      membersInVc = '0';
    }

  } else if (isGhost) {
    colour      = 0xFEE75C;
    statusLine  = 'Idle';
    channelLine = entry.channelName;
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0';
  } else {
    colour      = 0xED4245;
    statusLine  = 'Sleeping...';
    channelLine = '—';
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0';
  }

  return new EmbedBuilder()
    .setTitle('POW-Bot')
    .setColor(colour)
    .addFields(
      // Row 1: System Metrics
      { name: 'Status', value: statusLine, inline: true },
      { name: 'Uptime', value: `\`${processUp}\``, inline: true },
      { name: 'Memory', value: memMB, inline: true },
      
      // Row 2: Voice Channel Session Details
      { name: 'Current VC', value: channelLine, inline: true },
      { name: 'VC Uptime', value: `\`${vcUptime}\``, inline: true },
      { name: 'Members In VC', value: `\`${membersInVc}\``, inline: true }
    )
    .setFooter({ text: 'Last updated' })
    .setTimestamp();
}

// ── Stats embed ─────────────────────────────────────────────

function buildStatsEmbed(guildId, client, opts) {
  return require('./botInfo').buildBotInfoEmbed(guildId, client, opts);
}

// ── Member profile embed ──────────────────────────────────────────────────────

const KEY_PERMS = [
  ['Administrator',     'Administrator'],
  ['ManageGuild',       'Manage Server'],
  ['ManageChannels',    'Manage Channels'],
  ['ManageRoles',       'Manage Roles'],
  ['ManageMessages',    'Manage Messages'],
  ['ModerateMembers',   'Timeout Members'],
  ['KickMembers',       'Kick Members'],
  ['BanMembers',        'Ban Members'],
  ['ViewAuditLog',      'View Audit Log'],
];

function buildMemberEmbed(member, guild) {
  const user  = member.user;
  const stats = getUserStats(user.id, guild.id);
  const streamStats = getStreamStats(user.id, guild.id);

  let timeInServer = null;
  if (member.joinedAt) {
    const diff = Date.now() - member.joinedTimestamp;
    const d    = Math.floor(diff / 86400000);
    const h    = Math.floor((diff % 86400000) / 3600000);
    timeInServer = d > 0 ? `${d}d ${h}h` : `${h}h`;
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
    .setTitle('User Profile')
    // Section headers below use a plain bold bullet, not decorative emoji,
    // per request — just enough to visually separate each group of fields.
    .addFields({ name: '\u200b', value: '**▸ Account Overview**', inline: false })
    // Row 1: Registry Markers
    .addFields(
      { name: 'Joined Server', value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>\n(<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:D>\n(<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account Age', value: `\`${ageStr}\``, inline: true }
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
      { name: 'Total Sessions', value: `\`${stats.session_count}\``, inline: true },
      { name: 'Avg Time', value: `\`${formatMs(stats.avg_ms)}\``, inline: true },

      { name: 'Top VC', value: stats.top_channel ? `**${stats.top_channel}**\n(\`${formatMs(stats.top_channel_ms)}\`)` : '—', inline: true },
      { name: 'VC Streak', value: `\`${stats.streak} day(s)\``, inline: true },
      { name: 'Longest Session', value: `\`${formatMs(stats.longest_session_ms)}\``, inline: true },

      { name: 'Last Tracked', value: lastSeenStr, inline: true },
      { name: 'Longest Stream', value: `\`${formatMs(streamStats.longest_stream_ms)}\``, inline: true }
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

function buildPanelButtons() {
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
  );

  // Row 2: Identity & Discovery
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_myinfo')
      .setLabel('My Info')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('bot_lookup')
      .setLabel('User Lookup')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Bot information (a second button can be added here later)
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_info')
      .setLabel('Bot Info')
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
      await message.edit({ 
        embeds: [updatedEmbed],
        components: buildPanelButtons() // Keeps buttons interactive on update
      });
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
  buildStatsEmbed,
};
