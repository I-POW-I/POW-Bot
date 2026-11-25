/**
 * Bot information embeds — one place that builds everything shown by:
 *   • /botinfo (public, short)   • /owner status and the owner part of /botinfo
 *
 * Public view    : status, memory, uptime, version and whether the bot is in voice there
 * Owner view     : extra embeds for OWNER_IDS / ADMIN_IDS (Discloud container, event loop,
 *                  global usage, services, alert + safety settings)
 *
 * RAM always comes from system.js (Discloud's own reading when available).
 */

const fs   = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');

const store    = require('./connectionStore');
const system   = require('./system');
const alerts   = require('./errorAlerts');
const globalConfig = require('./globalConfig');
const diagnostics  = require('./diagnostics');
const { formatMs, selectOne, selectAll } = require('./database');
const { duration } = require('./duration');

const HEALTHY = [VoiceConnectionStatus.Ready, VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting];
const isConnected = (guildId) => { const c = getVoiceConnection(guildId); return !!c && HEALTHY.includes(c.state.status); };

const c  = (v) => `\`${v}\``;
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const n  = (v) => Number(v || 0).toLocaleString('en-GB');

const uptime = (sec) => duration(sec * 1000);

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

// ── Public status embed (everyone) ────────────────────────────────────────────

/**
 * The short version anyone can see: is the bot up, how much memory it uses, which version, and whether it is in voice here.
 * Anything about the host, memory, errors or other servers is owner-only (see buildOwnerEmbeds).
 */
function buildBotInfoEmbed(guildId, client) {
  const entry     = store.getEntry(guildId);
  const connected = isConnected(guildId);
  const channel   = connected && entry ? client.guilds.cache.get(guildId)?.channels.cache.get(entry.channelId) : null;
  const inVoice   = channel ? channel.members.filter(m => !m.user.bot).size : 0;

  const memory  = system.formatMemory();
  const voice = connected && channel
    ? `Connected to ${channel}\n${inVoice} ${inVoice === 1 ? 'member' : 'members'} with me, for ${store.formatUptime(entry.joinedAt)}`
    : 'Not in a voice channel';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('POW-Bot')
    .setThumbnail(client.user?.displayAvatarURL?.() || null)
    .setDescription('Voice 24/7, stream alerts, game updates, free games and server logs.')
    .addFields(
      { name: 'Status',  value: '🟢 Online', inline: true },
      { name: 'Memory',  value: memory, inline: true },
      { name: 'Uptime',  value: uptime(process.uptime()), inline: true },
      { name: 'Servers', value: n(client.guilds.cache.size), inline: true },
      { name: 'Version', value: `v${require('../package.json').version}`, inline: true },
      { name: 'Voice in this server', value: voice, inline: false },
    );
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
  );

  return [system_, usage, services];
}

module.exports = { buildBotInfoEmbed, buildOwnerEmbeds, getGlobalStats, servicesSummary };
