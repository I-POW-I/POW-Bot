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
      name:          `${meta.channelName} · ${store.formatUptime(meta.joinedAt)}`,
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

// ───────── Asynchronous Helper for Shared Dashboard Memory ─────────
/** Helper function to pull down the real container memory directly from Discloud */
async function fetchDiscloudMemory() {
  if (!process.env.DISCLOUD_TOKEN) return null;
  try {
    const response = await fetch("https://discloud.app", {
      method: 'GET',
      headers: {
        'api-token': process.env.DISCLOUD_TOKEN,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.apps && data.apps.memory) {
        return `\`${data.apps.memory}\``;
      }
    }
  } catch (error) {
    // Fail silently to trigger the default internal process memory fallback logic smoothly
  }
  return null;
}



// ── Panel embed ───────────────────────────────────────────────────────────────

/**
 * @param {string} guildId
 * @param {import('discord.js').Guild|null} guild — pass to show live member count
 * @param {string|null} discloudMem — Pass the synchronized Discloud memory metric down here
 */
function buildPanelEmbed(guildId, guild = null, discloudMem = null) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const isGhost   = entry && !getVoiceConnection(guildId);

  // REAL FIX: If discloudMem is null/undefined, safely fall back to a valid string instead of breaking Discord
  const memMB     = discloudMem || `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB / 500 MB\``;
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
    statusLine  = '🟡 Idle';
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

async function buildStatsEmbed(guildId, client) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const saved     = getStats(guildId);
  const totals    = getServerTotals(guildId);
  const ping      = client.ws.ping;
  const totalActive = client.guilds.cache.filter(g => isConnected(g.id)).size;

  const statusLabel = connected ? '🟢 Connected' : '🔴 Not connected';

  // ── 1. Fetching Discloud Live Memory Allocation (Dashboard Sync) ──
  let discloudMem = '`Loading...`';
  let containerStatus = '`Unknown`';
  let containerCpu = '`0.00%`';
  let containerSsd = '`—`';
  let containerNetIO = '`🔻 0KB 🔺 0KB`';
  let containerRestart = '`—`';
  let containerStarted = '`—`';

  try {
    if (process.env.DISCLOUD_TOKEN) {
      const response = await fetch(`https://api.discloud.app/v2/app/1781964404816/status`, {
        method: 'GET',
        headers: {
          'api-token': process.env.DISCLOUD_TOKEN,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const app = data.apps;

        if (app) {
          if (app.memory) {
            discloudMem = `\`${app.memory}\``; 
          }
          containerStatus = app.container ? `\`${app.container}\`` : containerStatus;
          containerCpu = app.cpu ? `\`${app.cpu}\`` : containerCpu;
          containerSsd = app.ssd ? `\`${app.ssd}\`` : containerSsd;
          containerRestart = app.last_restart ? `\`${app.last_restart}\`` : containerRestart;

          if (app.netIO) {
            containerNetIO = `\`🔻 ${app.netIO.down || '0KB'} 🔺 ${app.netIO.up || '0KB'}\``;
          }

          if (app.startedAt) {
            const dateObj = new Date(app.startedAt);
            if (!isNaN(dateObj.getTime())) {
              containerStarted = `\`${dateObj.toLocaleString('en-GB', { timeZone: 'Europe/London' })}\``;
            }
          }
        } else {
          discloudMem = `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB / 500 MB\``;
        }
      } else {
        discloudMem = `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB / 500 MB\``;
      }
    } else {
      discloudMem = `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB / 500 MB\``;
    }
  } catch (error) {
    discloudMem = `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB / 500 MB\``;
  }


  // ── 2. Pure Metadata Lookups (Guaranteed Non-Crashing Global Totals) ──
  const serverCount         = client.guilds.cache.size; 
  const serverChannels      = client.channels.cache.size || 0;
  const serverVoiceChannels = client.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size || 0;
  
  const serverMemberCount   = client.guilds.cache.reduce((acc, g) => acc + (g.memberCount || 0), 0);
  
  const activeMembersInVc   = client.guilds.cache.reduce((acc, g) => {
    if (isConnected(g.id)) {
      const activeEntry = store.getEntry(g.id);
      const ch = g.channels?.cache?.get(activeEntry?.channelId);
      const inVc = ch ? ch.members?.filter(m => !m.user.bot).size : 0;
      return acc + (inVc || 0);
    }
    return acc;
  }, 0);

  const embed = new EmbedBuilder()
    .setTitle('Server & Bot info')
    .setColor(connected ? 0x57F287 : 0xED4245)
    .setTimestamp();

  if (connected && entry) {
    const targetGuild = client.guilds.cache.get(guildId);
    const ch          = targetGuild?.channels.cache.get(entry.channelId);
    const inVc        = ch ? ch.members.filter(m => !m.user.bot).size : '—';

    embed.addFields(
      // Row 1: Connection & Core State
      { name: 'Status', value: statusLabel, inline: true },
      { name: 'VC Uptime', value: `\`${store.formatUptime(entry.joinedAt)}\``, inline: true },
      { name: 'Bot Uptime', value: `\`${getProcessUptime()}\``, inline: true },

      // Row 2: Performance Metrics
      { name: 'Web Socket Ping', value: ping >= 0 ? `\`${ping}ms\`` : '`Calculating...`', inline: true },
      { name: 'Discloud Memory', value: discloudMem, inline: true },
      { name: 'Members in VC', value: `\`${inVc}\``, inline: true },

      // Row 3: Tracking History totals
      { name: 'Reconnects', value: `\`${entry.reconnectCount}\``, inline: true },
      { name: 'Active VCs', value: `\`${totalActive} server(s)\``, inline: true },
      { name: 'Total Sessions', value: `\`${totals.total_sessions.toLocaleString()}\``, inline: true },

      // Row 4: Base Container Infrastructure Metrics
      { name: 'Container Cluster', value: '`ASTRA`', inline: true },
      { name: 'Container State', value: containerStatus, inline: true },
      { name: 'CPU Usage', value: containerCpu, inline: true },

      // Row 5: Secondary Infrastructure Storage & I/O Metrics
      { name: 'SSD Storage', value: containerSsd, inline: true },
      { name: 'Network I/O', value: containerNetIO, inline: true },
      { name: 'Last Restart', value: containerRestart, inline: true },

      // Row 6: Global Discord Gateway Metadata Listings
      { name: 'Server Count', value: `\`${serverCount}\``, inline: true },
      { name: 'Server Channels', value: `\`${serverChannels}\``, inline: true },
      { name: 'Server Voice Channels', value: `\`${serverVoiceChannels}\``, inline: true },

      // Row 7: Member Metrics & Grid Realignment Spacers
      { name: 'Server Member Count', value: `\`${serverMemberCount.toLocaleString()}\``, inline: true },
      { name: 'Active Members In VC', value: `\`${activeMembersInVc}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },

      // Row 8: Wide Base Data Fields
      { name: 'Container Started At', value: containerStarted, inline: false },
      {
        name: 'Persisted Stats',
        value: saved.joinedAt
          ? `Since <t:${Math.floor(new Date(saved.joinedAt).getTime() / 1000)}:R> · \`${saved.reconnectCount}\` reconnect(s)`
          : '*None saved yet*',
        inline: false,
      },
    );
  } else {
    embed.setDescription('💤 *Not currently connected to any voice channel.*')
      .addFields(
        { name: 'Bot Uptime', value: `\`${getProcessUptime()}\``, inline: true },
        { name: 'Discloud Memory', value: discloudMem, inline: true },
        { name: 'Web Socket Ping', value: ping >= 0 ? `\`${ping}ms\`` : '`—`', inline: true },
        { name: 'Container State', value: containerStatus, inline: true },
        { name: 'CPU Usage', value: containerCpu, inline: true },
        { name: 'Total Sessions', value: `\`${totals.total_sessions.toLocaleString()}\``, inline: true },
        { name: 'Container Started At', value: containerStarted, inline: false }
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

    vcLine = `<#${vc.channel.id}> ${sessionMs ? `— \`${formatLive(sessionMs)}\`` : ''}`;
    if (indicators.length > 0) vcLine += `\n⚙️ ${indicators.join('  •  ')}`;
  } else {
    vcLine = '💤 Not in a VC';
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
    .setTitle('🥷🏽 User Profile')
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
    if (vc?.channel) lastSeenStr = '🟢 Active Now';

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
  // Fetch real container memory to synchronize across all panels smoothly
  const liveMemory = await fetchDiscloudMemory();

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
      const updatedEmbed = buildPanelEmbed(guild.id, guild, liveMemory);
      await message.edit({ 
        embeds: [updatedEmbed],
        components: buildPanelButtons() // Keeps buttons interactive on update
      });
    } catch (err) {
      log('ERROR', `Failed to edit panel update for the following guild(s) ${guild.id}: ${err.message}`);
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
