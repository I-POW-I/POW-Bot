/**
 * Bot information embeds — one place that builds everything shown by:
 *   • /botinfo (full, server admins)   • /owner status
 *
 * Public view    : what every member may see (status, latency, RAM, uptime, services)
 * Owner view     : extra embeds for OWNER_IDS / ADMIN_IDS (Discloud container, event loop,
 *                  global usage, services, alert + safety settings)
 *
 * RAM always comes from system.js (Discloud's own reading when available).
 */

const fs   = require('fs');
const path = require('path');
const { EmbedBuilder, ChannelType } = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');

const store    = require('./connectionStore');
const system   = require('./system');
const alerts   = require('./errorAlerts');
const globalConfig = require('./globalConfig');
const diagnostics  = require('./diagnostics');
const { getStats }                  = require('./guildConfig');
const { getServerTotals, formatMs, selectOne, selectAll } = require('./database');

const HEALTHY = [VoiceConnectionStatus.Ready, VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting];
const isConnected = (guildId) => { const c = getVoiceConnection(guildId); return !!c && HEALTHY.includes(c.state.status); };

const c  = (v) => `\`${v}\``;
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const n  = (v) => Number(v || 0).toLocaleString('en-GB');

function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fileSize(file) {
  try { const b = fs.statSync(file).size; return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }
  catch { return 'n/a'; }
}

const DATA = path.join(__dirname, '..', 'data');

// ── Services (what's working, in plain words) ─────────────────────────────────

function servicesSummary() {
  const lines = [];
  try {
    const twitch = require('./platforms/twitch'), es = require('./platforms/twitchEventSub');
    lines.push(`Twitch — ${!twitch.hasCredentials() ? 'not configured' : es.isHealthy() ? 'instant alerts live' : 'polling every 60s'}`);
  } catch { lines.push('Twitch — unknown'); }
  try { lines.push(`Kick — ${require('./platforms/kick').hasCredentials() ? 'official API' : 'unofficial API (may be blocked)'}`); } catch { lines.push('Kick — unknown'); }
  lines.push(`YouTube — ${process.env.YOUTUBE_API_KEY ? 'enabled' : 'not configured'}`);
  return lines.join('\n');
}

// ── Status embed ──────────────────────────────────────────────────────────────

const LONDON = (ms) => { const d = new Date(ms); return isNaN(d) ? null : d.toLocaleString('en-GB', { timeZone: 'Europe/London' }); };

/**
 * @param {string} guildId
 * @param {import('discord.js').Client} client
 * @param {{ responseMs?: number, detailed?: boolean }} opts
 *   detailed — include the Discloud container rows (staff / bot owner).
 */
function buildBotInfoEmbed(guildId, client, { responseMs, detailed = true } = {}) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const saved     = getStats(guildId);
  const totals    = getServerTotals(guildId);
  const ping      = client.ws.ping;
  const mem       = system.getMemoryInfo();
  const dv        = system.discloudView();
  const last      = diagnostics.getLastError();
  const totalActive = client.guilds.cache.filter(g => isConnected(g.id)).size;

  const serverMemberCount = client.guilds.cache.reduce((acc, g) => acc + (g.memberCount || 0), 0);
  const activeMembersInVc = client.guilds.cache.reduce((acc, g) => {
    if (!isConnected(g.id)) return acc;
    const e  = store.getEntry(g.id);
    const ch = g.channels?.cache?.get(e?.channelId);
    return acc + (ch ? ch.members?.filter(m => !m.user.bot).size || 0 : 0);
  }, 0);

  const memLabel = mem.source === 'discloud' ? 'Discloud memory' : 'Memory';
  const pingText = ping >= 0 ? c(`${ping}ms`) : c('Calculating...');
  const started  = dv.startedAt ? LONDON(dv.startedAt) : null;

  const embed = new EmbedBuilder()
    .setTitle('Server & Bot info')
    .setColor(connected ? 0x57F287 : 0xED4245)
    .setTimestamp();

  const container = detailed ? [
    { name: 'Container cluster', value: c(dv.cluster || process.env.DISCLOUD_CLUSTER || 'ASTRA'), inline: true },
    { name: 'Container state',   value: c(dv.container || 'Unknown'), inline: true },
    { name: 'CPU Usage',         value: c(dv.cpu || `${system.getCpuPercent().toFixed(1)}%`), inline: true },
    { name: 'SSD Storage',       value: c(dv.ssd || '—'), inline: true },
    { name: 'Network I/O',       value: c(dv.net || 'In 0KB / Out 0KB'), inline: true },
    { name: 'Last restart',      value: c(dv.lastRestart || '—'), inline: true },
  ] : [];

  if (connected && entry) {
    const targetGuild = client.guilds.cache.get(guildId);
    const ch          = targetGuild?.channels.cache.get(entry.channelId);
    const inVc        = ch ? ch.members.filter(m => !m.user.bot).size : '—';

    embed.addFields(
      // Row 1: Connection & Core State
      { name: 'Status',    value: 'Connected', inline: true },
      { name: 'VC Uptime', value: c(store.formatUptime(entry.joinedAt)), inline: true },
      { name: 'Bot uptime', value: c(uptime(process.uptime())), inline: true },

      // Row 2: Performance Metrics
      { name: 'WebSocket ping', value: pingText, inline: true },
      { name: memLabel, value: c(system.formatMemory(mem)), inline: true },
      { name: 'Members in VC', value: c(inVc), inline: true },

      // Row 3: Tracking History totals
      { name: 'Reconnects', value: c(entry.reconnectCount), inline: true },
      { name: 'Active VCs', value: c(`${totalActive} server(s)`), inline: true },
      { name: 'Total sessions', value: c(n(totals.total_sessions)), inline: true },

      // Rows 4-5: Discloud container (staff / owner)
      ...container,

      // Row 6: Global Discord metadata
      { name: 'Server count', value: c(n(client.guilds.cache.size)), inline: true },
      ...(detailed ? [
        { name: 'Server channels', value: c(n(client.channels.cache.size || 0)), inline: true },
        { name: 'Server voice channels', value: c(n(client.channels.cache.filter(x => x.type === ChannelType.GuildVoice).size || 0)), inline: true },
      ] : [{ name: '\u200B', value: '\u200B', inline: true }, { name: '\u200B', value: '\u200B', inline: true }]),

      // Row 7: Member metrics
      { name: 'Server member count', value: c(n(serverMemberCount)), inline: true },
      { name: 'Active Members In VC', value: c(activeMembersInVc), inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
    );
    if (detailed && started) embed.addFields({ name: 'Container started at', value: c(started), inline: false });
    embed.addFields({
      name: 'Persisted stats',
      value: saved.joinedAt
        ? `Since <t:${Math.floor(new Date(saved.joinedAt).getTime() / 1000)}:R> · ${c(saved.reconnectCount)} reconnect(s)`
        : '*No persisted data yet*',
      inline: false,
    });
  } else {
    embed.setDescription('*Not currently connected to any voice channel.*').addFields(
      { name: 'Bot uptime', value: c(uptime(process.uptime())), inline: true },
      { name: memLabel, value: c(system.formatMemory(mem)), inline: true },
      { name: 'WebSocket ping', value: ping >= 0 ? c(`${ping}ms`) : c('—'), inline: true },
      ...(detailed ? [
        { name: 'Container state', value: c(dv.container || 'Unknown'), inline: true },
        { name: 'CPU Usage', value: c(dv.cpu || `${system.getCpuPercent().toFixed(1)}%`), inline: true },
      ] : []),
      { name: 'Total sessions', value: c(n(totals.total_sessions)), inline: true },
      ...(detailed && started ? [{ name: 'Container started at', value: c(started), inline: false }] : []),
    );
  }

  // Additions: latency, this server's voice time, version, services, last error
  embed.addFields(
    { name: 'Response time', value: c(responseMs != null ? `${responseMs} ms` : '—'), inline: true },
    { name: 'Voice Time (this server)', value: c(formatMs(totals.total_ms)), inline: true },
    { name: 'Version', value: c(`v${require('../package.json').version}`), inline: true },
    { name: 'Services', value: servicesSummary(), inline: false },
    { name: 'Last error', value: last ? `${ts(last.at)} — ${last.text}` : 'None since the bot started', inline: false },
  );
  embed.setFooter({ text: `Node ${process.version} · discord.js ${require('discord.js').version}` });
  return embed;
}

// ── Global statistics (owner) ─────────────────────────────────────────────────

function getGlobalStats(client) {
  const day = Date.now() - 86400e3, week = Date.now() - 7 * 86400e3;

  const sessions = selectOne('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms, COUNT(DISTINCT user_id) AS users FROM vc_sessions WHERE duration_ms IS NOT NULL') || {};
  const last24   = selectOne('SELECT COUNT(*) AS n FROM vc_sessions WHERE joined_at > ?', [day]) || {};
  const topWeek  = selectAll('SELECT guild_id, COALESCE(SUM(duration_ms),0) AS ms FROM vc_sessions WHERE duration_ms IS NOT NULL AND joined_at > ? GROUP BY guild_id ORDER BY ms DESC LIMIT 3', [week]);
  const streams  = selectAll('SELECT platform, COUNT(*) AS n, COALESCE(SUM(is_live),0) AS live FROM streamer_subscriptions GROUP BY platform');
  const games    = selectOne('SELECT COUNT(*) AS n FROM game_subscriptions') || {};

  let members = 0, inVoice = 0;
  for (const g of client.guilds.cache.values()) {
    members += g.memberCount || 0;
    for (const vs of g.voiceStates.cache.values()) if (vs.channelId && !vs.member?.user?.bot) inVoice++;
  }

  return {
    servers: client.guilds.cache.size, members, usersCached: client.users.cache.size,
    voiceConnections: client.guilds.cache.filter(g => isConnected(g.id)).size, inVoice,
    sessions: sessions.n || 0, voiceMs: sessions.ms || 0, trackedUsers: sessions.users || 0, sessions24h: last24.n || 0,
    topWeek: topWeek.map(r => ({ name: client.guilds.cache.get(r.guild_id)?.name || r.guild_id, ms: r.ms })),
    streams, gameAlerts: games.n || 0,
    dbSize: fileSize(path.join(DATA, 'pow-bot.db')), configSize: fileSize(path.join(DATA, 'guild-config.json')),
  };
}

// ── Owner embeds ──────────────────────────────────────────────────────────────

/** Three embeds: System · Usage · Services & safety. */
async function buildOwnerEmbeds(client) {
  const snap = await system.getSnapshot({ force: true });
  const g    = getGlobalStats(client);
  const m    = snap.memory, d = snap.discloud;
  const cfg  = globalConfig.get();
  const ctr  = diagnostics.getCounters();
  const usedRestarts = cfg.restarts.filter(t => Date.now() - t < 86400e3).length;
  const settings = require('./ownerMonitor').getSettings();

  const system_ = new EmbedBuilder().setColor(0x5865F2).setTitle('System').addFields(
    { name: 'Container',     value: c(d.container || (d.configured ? 'n/a' : 'API not set')), inline: true },
    { name: 'RAM',           value: c(system.formatMemory(m)), inline: true },
    { name: 'RAM source',    value: c(m.source === 'discloud' ? 'Discloud' : 'Process (RSS)'), inline: true },
    { name: 'CPU (Discloud)', value: c(d.cpu || 'n/a'), inline: true },
    { name: 'CPU (process)', value: c(`${snap.cpuPercent.toFixed(1)}%`), inline: true },
    { name: 'Storage',       value: c(d.ssd || 'n/a'), inline: true },
    { name: 'Network',       value: c(d.net || 'n/a'), inline: true },
    { name: 'Last restart',  value: c(d.lastRestart || 'n/a'), inline: true },
    { name: 'Auto-restarts', value: c(`${usedRestarts} / ${settings.maxPerDay} in 24h`), inline: true },
    { name: 'Event loop delay', value: c(`avg ${snap.loop.meanMs.toFixed(1)} · p99 ${snap.loop.p99Ms.toFixed(1)} · max ${snap.loop.maxMs.toFixed(1)} ms`), inline: false },
    { name: 'Memory detail', value: c(`RSS ${Math.round(m.rssMb)} · heap ${Math.round(m.heapMb)}/${Math.round(m.heapTotalMb)} · external ${Math.round(m.externalMb)} · buffers ${Math.round(m.arrayBuffersMb)} MB`), inline: false },
    { name: 'Runtime',       value: c(`Node ${snap.node} · discord.js ${snap.discordjs} · ${snap.platform}`), inline: false },
  );
  if (d.ramKilled) system_.addFields({ name: 'Discloud flag', value: `Marked **killed for RAM** (exit code ${d.exitCode ?? '?'})`, inline: false });
  if (d.error)     system_.addFields({ name: 'Discloud API', value: d.error, inline: false });

  const platforms = g.streams.length
    ? g.streams.map(s => `${s.platform} ${s.n} (${s.live} live)`).join(' · ') : 'none';
  const usage = new EmbedBuilder().setColor(0x57F287).setTitle('Usage').addFields(
    { name: 'Servers',            value: c(n(g.servers)), inline: true },
    { name: 'Members (total)',    value: c(n(g.members)), inline: true },
    { name: 'Users cached',       value: c(n(g.usersCached)), inline: true },
    { name: 'Voice connections',  value: c(g.voiceConnections), inline: true },
    { name: 'Members in voice',   value: c(g.inVoice), inline: true },
    { name: 'Tracked users',      value: c(n(g.trackedUsers)), inline: true },
    { name: 'VC sessions (all-time)', value: c(n(g.sessions)), inline: true },
    { name: 'VC time (all-time)', value: c(formatMs(g.voiceMs)), inline: true },
    { name: 'Sessions (24h)',     value: c(n(g.sessions24h)), inline: true },
    { name: 'Top servers (7 days)', value: g.topWeek.length ? g.topWeek.map((t, i) => `${i + 1}. ${t.name} — ${formatMs(t.ms)}`).join('\n') : 'No data yet', inline: false },
    { name: 'Streamers watched',  value: platforms, inline: true },
    { name: 'Game alerts',        value: c(g.gameAlerts), inline: true },
    { name: 'Since start',        value: c(`${n(ctr.commands)} commands · ${n(ctr.buttons)} buttons · ${ctr.errors} errors · ${ctr.warnings} warnings`), inline: false },
    { name: 'Data files',         value: c(`database ${g.dbSize} · server settings ${g.configSize}`), inline: false },
  );

  const dest = alerts.describeDestinations();
  const where = [dest.webhook && 'webhook', dest.channel && 'private channel', dest.dm && 'DMs'].filter(Boolean).join(' + ') || 'NOT SET';
  const flags = Object.entries(cfg.features).map(([k, v]) => `${k}: ${v ? 'on' : '**off**'}`).join(' · ');
  const services = new EmbedBuilder().setColor(0xFAA61A).setTitle('Services & safety').addFields(
    { name: 'Integrations',      value: servicesSummary(), inline: false },
    { name: 'Alerts go to',      value: `${where}${dest.muted ? ' · **muted**' : ''}`, inline: true },
    { name: 'Alert levels',      value: c(dest.levels.join(', ')), inline: true },
    { name: 'Console digest',    value: c(settings.digestMinutes > 0 ? `every ${settings.digestMinutes} min` : 'off'), inline: true },
    { name: 'Maintenance mode',  value: cfg.maintenance.enabled ? `**ON** since ${ts(cfg.maintenance.since)}` : 'off', inline: true },
    { name: 'Memory auto-restart', value: c(settings.memoryPercent > 0 ? `at ${settings.memoryPercent}%` : 'off'), inline: true },
    { name: 'Blocked',           value: c(`${Object.keys(cfg.blacklist.users).length} users · ${Object.keys(cfg.blacklist.guilds).length} servers`), inline: true },
    { name: 'Feature switches',  value: flags, inline: false },
  ).setTimestamp();

  return [system_, usage, services];
}

module.exports = { buildBotInfoEmbed, buildOwnerEmbeds, getGlobalStats, servicesSummary };
