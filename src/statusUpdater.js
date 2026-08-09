const {
  ActivityType, EmbedBuilder, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { log }                              = require('./logger');
const store                                = require('./connectionStore');
const { getGuildConfig, getStats, getLogChannel } = require('./guildConfig');
const { getUserStats, getServerTotals, formatMs }  = require('./database');
const { joinTimes, streamTimes }           = require('./memberTracker');

const PRESENCE_INTERVAL  = 60 * 1000;
const ROTATION_INTERVAL  = 20 * 1000;
let rotationIndex = 0;

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

function buildRotationSlots(client) {
  const active = store.getAllEntries().filter(([guildId]) => isConnected(guildId));
  const slots = [];
  for (const [, meta] of active) {
    slots.push({
      name:          `🔊 ${meta.channelName} · ${store.formatUptime(meta.joinedAt)}`,
      discordStatus: 'dnd',
      type:          ActivityType.Custom,
    });
  }
  const totalMembers = client.guilds.cache.reduce((sum, g) => sum + g.memberCount, 0);
  slots.push({
    name:          `${totalMembers.toLocaleString()} members`,
    discordStatus: 'dnd',
    type:          ActivityType.Watching,
  });
  return slots;
}

function startStatusUpdater(client) {
  const rotate = () => {
    const slots = buildRotationSlots(client);
    rotationIndex = rotationIndex % slots.length;
    const slot = slots[rotationIndex];
    client.user.setPresence({ status: slot.discordStatus, activities: [{ name: slot.name, type: slot.type }] });
    rotationIndex++;
  };
  rotate();
  setInterval(rotate, ROTATION_INTERVAL);
  const panelUpdate = async () => { await updatePanel(client); };
  panelUpdate();
  setInterval(panelUpdate, PRESENCE_INTERVAL);
  log('INFO', 'Status updater started (20s rotation · 60s panel)');
}

// ── Panel embed ───────────────────────────────────────────────────────────────

/**
 * @param {string} guildId
 * @param {import('discord.js').Guild|null} guild  — pass to show live member count
 */
function buildPanelEmbed(guildId, guild = null) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const isGhost   = entry && !getVoiceConnection(guildId);

  const memMB     = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  let colour, statusLine, channelLine, vcUptime, processUp, membersInVc;

  if (connected && entry) {
    colour      = 0x57F287;
    statusLine  = '🟢 Connected';
    channelLine = `**${entry.channelName}**`;
    vcUptime    = store.formatUptime(entry.joinedAt);
    processUp   = getProcessUptime();

    // Live member count in the VC (excluding bots)
    if (guild) {
      const ch = guild.channels.cache.get(entry.channelId);
      membersInVc = ch ? `${ch.members.filter(m => !m.user.bot).size}` : '—';
    } else {
      membersInVc = '—';
    }

  } else if (isGhost) {
    colour      = 0xFEE75C;
    statusLine  = '🟡 Stalled Connection — Use Force Leave to Reset';
    channelLine = entry.channelName;
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '—';
  } else {
    colour      = 0xED4245;
    statusLine  = '🔴 Sleeping...';
    channelLine = '—';
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '—';
  }

  return new EmbedBuilder()
    .setTitle('[TEST] POW-Bot 🖤')
    .setColor(colour)
    .addFields(
      { name: 'Status',      value: statusLine,  inline: true },
      { name: 'Channel',     value: channelLine, inline: true },
      { name: 'VC Uptime',   value: vcUptime,    inline: true },
      { name: 'Members',     value: membersInVc, inline: true },
      { name: 'Process Up',  value: processUp,   inline: true },
      { name: 'Memory',      value: `${memMB} MB`, inline: true },
    )
    .setFooter({ text: 'Last updated' })
    .setTimestamp();
}

// ── Stats embed ─────────────────────────────────────────────

function buildStatsEmbed(guildId, client) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const saved     = getStats(guildId);
  const totals    = getServerTotals(guildId);
  const memMB     = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const ping      = client.ws.ping;
  const totalActive = client.guilds.cache.filter(g => isConnected(g.id)).size;

  // Always show 🟢 Connected for any healthy state — don't expose internal state names
  const statusLabel = connected ? '🟢 Connected' : '🔴 Not connected';

  const embed = new EmbedBuilder()
    .setTitle('POW-Bot 🖤 — Status')
    .setColor(connected ? 0x57F287 : 0xED4245)
    .setTimestamp();

  if (connected && entry) {
    // Live member count
    const guild     = client.guilds.cache.get(guildId);
    const ch        = guild?.channels.cache.get(entry.channelId);
    const inVc      = ch ? ch.members.filter(m => !m.user.bot).size : '—';

    embed.addFields(
      { name: 'Connection',     value: statusLabel,                                                         inline: true  },
      { name: 'VC Uptime',      value: store.formatUptime(entry.joinedAt),                                  inline: true  },
      { name: 'Process Uptime', value: getProcessUptime(),                                                  inline: true  },
      { name: 'WebSocket Ping', value: ping >= 0 ? `${ping}ms` : 'Calculating...',                         inline: true  },
      { name: 'Members in VC',  value: `${inVc}`,                                                          inline: true  },
      { name: 'Memory',         value: `${memMB} MB`,                                                      inline: true  },
      {
        name:  'Reconnects',
        value: `${entry.reconnectCount}`,
        inline: true,
      },
      { name: 'Active VCs',    value: `${totalActive} server(s)`,                                          inline: true  },
      { name: 'Sessions Tracked (DB)', value: `${totals.total_sessions.toLocaleString()}`,                 inline: true  },
      {
        name:   'Persisted Stats',
        value:  saved.joinedAt
          ? `Since <t:${Math.floor(new Date(saved.joinedAt).getTime() / 1000)}:R> · ${saved.reconnectCount} reconnect(s)`
          : 'None saved yet',
        inline: false,
      },
    );
  } else {
    embed.setDescription('Not currently connected to any voice channel.').addFields(
      { name: 'Process Uptime', value: getProcessUptime(), inline: true },
      { name: 'Memory',         value: `${memMB} MB`,      inline: true },
      { name: 'WebSocket Ping', value: ping >= 0 ? `${ping}ms` : '—', inline: true },
      { name: 'Sessions Tracked (DB)', value: `${totals.total_sessions.toLocaleString()}`, inline: true },
    );
  }

  return embed;
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
  const user    = member.user;
  const stats   = getUserStats(user.id, guild.id);



  // ── Time in server ────────────────────────────────────────────────────────
  let timeInServer = null;
  if (member.joinedAt) {
    const diff = Date.now() - member.joinedTimestamp;
    const d    = Math.floor(diff / 86400000);
    const h    = Math.floor((diff % 86400000) / 3600000);
    timeInServer = d > 0 ? `${d}d ${h}h` : `${h}h`;
  }

  // ── Timeout status ────────────────────────────────────────────────────────
  const timedOut = member.communicationDisabledUntil && member.communicationDisabledUntil > new Date();

  // ── Key permissions ───────────────────────────────────────────────────────
  let permStr = null;
  try {
    const perms = member.permissions;
    if (perms.has(PermissionsBitField.Flags.Administrator)) {
      permStr = 'Administrator';
    } else {
      const has = KEY_PERMS.filter(([f]) => perms.has(PermissionsBitField.Flags[f])).map(([,l]) => l);
      if (has.length > 0) permStr = has.join(', ');
    }
  } catch {}

  // ── Account age ──────────────────────────────────────────────────────────
  const ageMs     = Date.now() - user.createdAt.getTime();
  const ageYears  = Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
  const ageMonths = Math.floor((ageMs % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
  const ageStr    = ageYears > 0 ? `${ageYears}y ${ageMonths}m` : `${ageMonths} month(s)`;

  // ── Nickname ──────────────────────────────────────────────────────────────
  const nickname = member.nickname && member.nickname !== user.username
    ? member.nickname
    : null;

  // ── Boost status ─────────────────────────────────────────────────────────
  const boostSince = member.premiumSince;
  const boostStr   = boostSince
    ? `Boosting since <t:${Math.floor(boostSince.getTime() / 1000)}:R>`
    : 'Not boosting';

  // ── Current voice state ───────────────────────────────────────────────────
  const vc  = member.voice;
  const vcKey = `${guild.id}_${user.id}`;
  let vcLine;

  if (vc?.channel) {
    const sessionMs = joinTimes.has(vcKey) ? Date.now() - joinTimes.get(vcKey) : null;
    const streaming = streamTimes.has(vcKey);

    const indicators = [
      vc.selfMute   ? 'Muted'       : null,
      vc.selfDeaf   ? 'Deafened'    : null,
      vc.serverMute ? 'Server Muted' : null,
      vc.serverDeaf ? 'Server Deafened'  : null,
      vc.streaming  ? 'Streaming'   : null,
      vc.selfVideo  ? 'Live Camera'       : null,
    ].filter(Boolean);

    vcLine = `<#${vc.channel.id}> — **${vc.channel.name}**`;
    if (sessionMs) vcLine += ` · ${formatLive(sessionMs)}`;
    if (streaming) {
      const streamMs = Date.now() - streamTimes.get(vcKey);
      vcLine += `\nStreaming for ${formatLive(streamMs)}`;
    }
    if (indicators.length > 0) vcLine += `\n${indicators.join(' · ')}`;
  } else {
    vcLine = 'Not in a voice channel';
  }

  // ── Last seen ─────────────────────────────────────────────────────────────
  let lastSeenStr = '—';
  if (vc?.channel) {
    lastSeenStr = 'Currently in VC';
  } else if (stats.last_seen) {
    lastSeenStr = `<t:${Math.floor(stats.last_seen / 1000)}:R>`;
  }

  // ── Roles (exclude @everyone, max 10) ─────────────────────────────────────
  const roles = member.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .first(10)
    .map(r => `<@&${r.id}>`);

  // ── Build embed ───────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(member.displayColor || 0x5865F2)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true, size: 256 }) })
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setTitle('User Profile')
    .addFields(
      { name: 'Joined Server',  value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>\n<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:D>\n<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Account Age',    value: ageStr, inline: true },
    );

  if (timeInServer) {
    embed.addFields({ name: 'Time in Server', value: timeInServer, inline: true });
  }

  if (nickname) {
    embed.addFields({ name: 'Nickname', value: nickname, inline: true });
  }

  embed.addFields({ name: 'Boost Status', value: boostStr, inline: false });

  if (timedOut) {
    embed.addFields({ name: 'Timed Out', value: `Until <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>`, inline: true });
  }



  embed.addFields({ name: 'In Voice', value: vcLine, inline: false });

  // ── VC Stats (from database) ────────────────────────────────────────────────
  if (stats.session_count > 0) {
    embed.addFields(
      { name: 'Total VC Time',   value: formatMs(stats.total_ms),                              inline: true },
      { name: 'Sessions',        value: `${stats.session_count}`,                              inline: true },
      { name: 'Avg Session',     value: formatMs(stats.avg_ms),                                inline: true },
      { name: 'Top Channel',     value: stats.top_channel
          ? `**${stats.top_channel}** (${formatMs(stats.top_channel_ms)})`
          : '—',                                                                                 inline: true },
      { name: 'VC Streak',       value: stats.streak > 0 ? `${stats.streak} day(s)` : '—', inline: true },
      { name: 'Last Seen in VC', value: lastSeenStr,                                            inline: true },
    );
  } else {
    embed.addFields({ name: 'VC Stats', value: 'No sessions tracked yet for this member.', inline: false });
  }

  if (roles.length > 0) {
    embed.addFields({
      name:  `Roles (${member.roles.cache.size - 1})`,
      value: roles.join(' '),
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}

// ── Panel buttons ─────────────────────────────────────────────────────────────

function buildPanelButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_join')
      .setLabel('Join')
      .setEmoji('▪️')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('bot_leave')
      .setLabel('Leave')
      .setEmoji('▪️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('bot_forceleave')
      .setLabel('Leave & Reset')
      .setEmoji('▪️')
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_myinfo')
      .setLabel('My Info')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('bot_lookup')
      .setLabel('User Lookup')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('bot_refresh')
      .setLabel('Panel Refresh')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
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
  for (const guild of client.guilds.cache.values()) {
    const config = getGuildConfig(guild.id);
    if (!config.panelChannelId || !config.panelMessageId) continue;

    try {
      const channel = await guild.channels.fetch(config.panelChannelId);
      if (!channel?.isTextBased()) continue;
      const message = await channel.messages.fetch(config.panelMessageId);
      await message.edit({
        embeds:     [buildPanelEmbed(guild.id, guild)],
        components: buildPanelButtons(),
      });
    } catch (err) {
      log('WARN', 'Could not update panel', { guild: guild.name, error: err.message });
    }
  }
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
