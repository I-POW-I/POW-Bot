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
      membersInVc = ch ? `${ch.members.filter(m => !m.user.bot).size}` : '0';
    } else {
      membersInVc = '0';
    }

  } else if (isGhost) {
    colour      = 0xFEE75C;
    statusLine  = '🟡 Stalled';
    channelLine = entry.channelName;
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0';
  } else {
    colour      = 0xED4245;
    statusLine  = '🔴 Sleeping...';
    channelLine = '—';
    vcUptime    = '—';
    processUp   = getProcessUptime();
    membersInVc = '0';
  }

  // Native responsive grid structure matching your exact sequence
  return new EmbedBuilder()
    .setTitle('POW-Bot 🖤')
    .setColor(colour)
    .addFields(
      // Row 1: System Metrics
      { name: '🚥 Status', value: statusLine, inline: true },
      { name: 'Uptime', value: `\`${processUp}\``, inline: true },
      { name: 'Memory', value: `\`${memMB} MB\``, inline: true },
      
      // Row 2: Voice Channel Session Details
      { name: 'Current VC', value: channelLine, inline: true },
      { name: 'VC Uptime', value: `\`${vcUptime}\``, inline: true },
      { name: 'Members In VC', value: `\`${membersInVc}\``, inline: true }
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

  const statusLabel = connected ? '🟢 Connected' : '🔴 Not connected';

  const embed = new EmbedBuilder()
    .setTitle('POW-Bot 🖤 Server & Bot info')
    .setColor(connected ? 0x57F287 : 0xED4245)
    .setTimestamp();

  if (connected && entry) {
    const guild     = client.guilds.cache.get(guildId);
    const ch        = guild?.channels.cache.get(entry.channelId);
    const inVc      = ch ? ch.members.filter(m => !m.user.bot).size : '—';

    embed.addFields(
      // Row 1: Connection & Core State
      { name: '🚥 Status', value: statusLabel, inline: true },
      { name: 'VC Uptime', value: `\`${store.formatUptime(entry.joinedAt)}\``, inline: true },
      { name: 'Bot Uptime', value: `\`${getProcessUptime()}\``, inline: true },

      // Row 2: Performance Metrics
      { name: 'Web Socket Ping', value: ping >= 0 ? `\`${ping}ms\`` : '`Calculating...`', inline: true },
      { name: 'Memory', value: `\`${memMB} MB\``, inline: true },
      { name: 'Members in VC', value: `\`${inVc}\``, inline: true },

      // Row 3: Tracking History totals
      { name: 'Reconnects', value: `\`${entry.reconnectCount}\``, inline: true },
      { name: '🔊 Active VCs', value: `\`${totalActive} server(s)\``, inline: true },
      { name: 'Total Sessions', value: `\`${totals.total_sessions.toLocaleString()}\``, inline: true },

      // Row 4: Wide Base Data
      {
        name: 'Persisted Stats',
        value: saved.joinedAt
          ? `Since <t:${Math.floor(new Date(saved.joinedAt).getTime() / 1000)}:R> · \`${saved.reconnectCount}\` reconnect(s)`
          : '*None saved yet*',
        inline: false,
      },
    );
  } else {
    // Clean 4-Field grid when the bot is resting
    embed.setDescription('💤 *Not currently connected to any voice channel.*')
      .addFields(
        { name: 'Bot Uptime', value: `\`${getProcessUptime()}\``, inline: true },
        { name: 'Memory', value: `\`${memMB} MB\``, inline: true },
        { name: 'Web Socket Ping', value: ping >= 0 ? `\`${ping}ms\`` : '`—`', inline: true },
        { name: 'Total Sessions', value: `\`${totals.total_sessions.toLocaleString()}\``, inline: true }
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
  const user  = member.user;
  const stats = getUserStats(user.id, guild.id);

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
  const boostStr   = boostSince ? `💜 <t:${Math.floor(boostSince.getTime() / 1000)}:R>` : '❌ No';

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

    vcLine = `🔊 <#${vc.channel.id}> ${sessionMs ? `— \`${formatLive(sessionMs)}\`` : ''}`;
    if (indicators.length > 0) vcLine += `\n⚙️ ${indicators.join('  •  ')}`;
  } else {
    vcLine = '💤 Not in a VC';
  }

  const roles = member.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .first(10)
    .map(r => `<@&${r.id}>`);

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || 0x5865F2)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setTitle('🥷🏽 User Profile Profile')
    // Row 1: Registry Markers
    .addFields(
      { name: 'Joined Server', value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>\n(<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:D>\n(<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Account Age', value: `\`${ageStr}\``, inline: true },

      // Row 2: Presence Metadata
      { name: 'Nickname', value: `\`${nickname}\``, inline: true },
      { name: 'Time in Server', value: `\`${timeInServer || '—'}\``, inline: true },
      { name: 'Boosting', value: boostStr, inline: true },

      // Row 3: Live Channels (Pushed to wide row block)
      { name: 'Active VC', value: vcLine, inline: false }
    );

  // Row 4: Historical Metrics (Clean 3-Column Performance Grid)
  if (stats.session_count > 0) {
    let lastSeenStr = stats.last_seen ? `<t:${Math.floor(stats.last_seen / 1000)}:R>` : '—';
    if (vc?.channel) lastSeenStr = '🟢 Active Now';

    embed.addFields(
      { name: 'Total VC Time', value: `\`${formatMs(stats.total_ms)}\``, inline: true },
      { name: 'Total Sessions', value: `\`${stats.session_count}\``, inline: true },
      { name: 'Avg Time', value: `\`${formatMs(stats.avg_ms)}\``, inline: true },

      { name: 'Top VC', value: stats.top_channel ? `**${stats.top_channel}**\n(\`${formatMs(stats.top_channel_ms)}\`)` : '—', inline: true },
      { name: 'VC Streak', value: `\`${stats.streak} day(s)\``, inline: true },
      { name: 'Last Tracked', value: lastSeenStr, inline: true }
    );
  }

  // Row 5: Role Badges
  if (roles.length > 0) {
    embed.addFields({ name: `Assigned Roles (${member.roles.cache.size - 1})`, value: roles.join(' '), inline: false });
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
      .setEmoji('🟩')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('bot_leave')
      .setLabel('Leave')
      .setEmoji('🟧')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2: Management & Maintenance
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_forceleave')
      .setLabel('Leave & Reset')
      .setEmoji('🟥')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('bot_refresh')
      .setLabel('Panel Refresh')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Identity & Discovery
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_myinfo')
      .setLabel('My Info')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('bot_lookup')
      .setLabel('User Lookup')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Secondary)
  );

  // 🛠️ NEW Row 4: Administration Custom Tools
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bot_admin_drag_init') // 🛠️ Updated customId
      .setLabel('Move Users')
      .setEmoji('▫️')
      .setStyle(ButtonStyle.Secondary)
  );


  return [row1, row2, row3, row4];
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
  buildStatsEmbed,
};
