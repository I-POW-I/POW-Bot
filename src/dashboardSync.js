/*
 * Dashboard connectivity layer.
 *
 * This is the piece that was missing: the dashboard has always had
 * /api/bot/sync and /api/bot/commands endpoints waiting for the bot to
 * talk to them, but nothing in the bot ever called them. That's why the
 * dashboard shows the bot as offline/disconnected even when it's running fine.
 *
 * What this file does:
 *   1. Pushes a heartbeat (online, ping, guild count, active VC count) to
 *      POST /api/bot/sync every 60s so the dashboard's "Connected" status
 *      and health endpoint reflect reality.
 *   2. Polls GET /api/bot/commands?status=pending every 15s for commands
 *      queued by the dashboard's Owner Controls page (restart, presence,
 *      sync, refresh_status), runs them, then PATCHes the result back so
 *      the dashboard knows they completed.
 *
 * Requires two env vars (same names used by the dashboard/webhook trigger):
 *   DASHBOARD_URL   e.g. https://your-dashboard.discloud.app
 *   BOT_API_TOKEN   shared secret — must match the dashboard's BOT_API_TOKEN
 *
 * Both are optional. If either is missing this module logs a warning once
 * and does nothing else — it never throws and never blocks bot startup.
 */

const { log } = require('./logger');
const store = require('./connectionStore');
const { setDashboardPresences } = require('./statusUpdater');

const SYNC_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;

function getConfig() {
  const dashboardUrl = process.env.DASHBOARD_URL?.replace(/\/+$/, '');
  const token = process.env.BOT_API_TOKEN;
  return { dashboardUrl, token };
}

async function callDashboard(path, options = {}) {
  const { dashboardUrl, token } = getConfig();
  if (!dashboardUrl || !token) return null;

  const res = await fetch(`${dashboardUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res;
}

function buildStatusPayload(client) {
  const activeConnections = store.getAllEntries().length;
  const totalMembers = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
  const memoryMb = process.memoryUsage().rss / (1024 * 1024);

  return {
    online: true,
    ping_ms: Number.isFinite(client.ws.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
    active_connections: activeConnections,
    total_guilds: client.guilds.cache.size,
    total_members: totalMembers,
    process_uptime_ms: Math.round(process.uptime() * 1000),
    memory_mb: Math.round(memoryMb * 10) / 10,
  };
}

async function pushStatus(client) {
  try {
    const res = await callDashboard('/api/bot/sync', {
      method: 'POST',
      body: JSON.stringify({ bot_status: buildStatusPayload(client) }),
    });
    if (!res) return; // not configured
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('WARN', `Dashboard sync rejected (${res.status})`, { body: text.slice(0, 200) });
    }
  } catch (err) {
    log('WARN', 'Dashboard sync failed', { error: err.message });
  }
}

// ── Remote command handling ──────────────────────────────────────────────────

async function markCommand(id, status, extra = {}) {
  try {
    await callDashboard(`/api/bot/commands/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...extra }),
    });
  } catch (err) {
    log('WARN', `Failed to mark bot_command ${id} as ${status}`, { error: err.message });
  }
}

const VALID_TYPES = ['Playing', 'Watching', 'Listening', 'Custom'];

function normalizePresence(p) {
  const type = VALID_TYPES.includes(p?.type) ? p.type : 'Custom';
  const text = String(p?.text || '').slice(0, 128).trim();
  return { type, text };
}

async function applyPresenceCommand(client, payload) {
  const mode = payload?.mode === 'fixed' ? 'fixed' : 'rotate';
  const rawList = Array.isArray(payload?.presences)
    ? payload.presences
    : payload?.text
      ? [{ type: payload.type, text: payload.text }] // back-compat with the old single-presence shape
      : [];

  const presences = rawList.map(normalizePresence).filter((p) => p.text).slice(0, 3);
  if (!presences.length) throw new Error('Presence command had no usable text');

  // Hand off to statusUpdater's rotation — it decides whether these blend in
  // (mode: 'rotate') or fully replace the rotation (mode: 'fixed'). The next
  // 20s rotation tick will pick this up and apply it to Discord.
  setDashboardPresences(mode, presences);
}

async function processCommand(client, cmd) {
  switch (cmd.command) {
    case 'restart':
      await markCommand(cmd.id, 'completed');
      log('WARN', 'Restart requested from dashboard — exiting for Discloud to restart the process.');
      setTimeout(() => process.exit(0), 500);
      return;

    case 'presence':
      await applyPresenceCommand(client, cmd.payload);
      await markCommand(cmd.id, 'completed');
      return;

    case 'sync':
    case 'refresh_status':
      await pushStatus(client);
      await markCommand(cmd.id, 'completed');
      return;

    case 'fetch_channels': {
      const { getGuildChannels } = require('./guildDataApi');
      const channels = getGuildChannels(client, cmd.guild_id);
      await markCommand(cmd.id, 'completed', { result: { channels } });
      return;
    }

    case 'fetch_roles': {
      const { getGuildRoles } = require('./guildDataApi');
      const roles = getGuildRoles(client, cmd.guild_id);
      await markCommand(cmd.id, 'completed', { result: { roles } });
      return;
    }

    case 'render_preview': {
      const { renderWelcomePreview } = require('./guildDataApi');
      const image_base64 = await renderWelcomePreview(client, cmd.guild_id, cmd.payload || {});
      await markCommand(cmd.id, 'completed', { result: { image_base64 } });
      return;
    }

    default:
      await markCommand(cmd.id, 'failed', { error_message: `Unknown command: ${cmd.command}` });
  }
}

async function pollCommands(client) {
  try {
    const res = await callDashboard('/api/bot/commands?status=pending&limit=10', { method: 'GET' });
    if (!res) return; // not configured
    if (!res.ok) return;
    const { commands } = await res.json();
    for (const cmd of commands || []) {
      try {
        await processCommand(client, cmd);
      } catch (err) {
        log('ERROR', `bot_command ${cmd.id} (${cmd.command}) failed`, { error: err.message });
        await markCommand(cmd.id, 'failed', { error_message: err.message });
      }
    }
  } catch (err) {
    log('WARN', 'Dashboard command poll failed', { error: err.message });
  }
}

function startDashboardSync(client) {
  const { dashboardUrl, token } = getConfig();
  if (!dashboardUrl || !token) {
    log('WARN', 'DASHBOARD_URL or BOT_API_TOKEN missing — the dashboard will show this bot as offline and Owner Controls (restart/presence) will not reach it.');
    return;
  }

  client.once('ready', () => {
    pushStatus(client);
    pollCommands(client);
    setInterval(() => pushStatus(client), SYNC_INTERVAL_MS).unref();
    setInterval(() => pollCommands(client), POLL_INTERVAL_MS).unref();
    log('INFO', 'Dashboard sync started (60s heartbeat · 15s command poll).');
  });

  // Best-effort: let the dashboard know we're going offline on a clean shutdown.
  // This must never delay or block the actual shutdown — if DASHBOARD_URL is
  // unreachable (network blip, DNS issue, etc.) we still need to exit promptly
  // so Discloud's restart/redeploy isn't held up waiting on us.
  function goOffline() {
    const finish = () => process.exit(0);
    const timer = setTimeout(finish, 2_000); // hard cap regardless of what happens below
    timer.unref?.();

    callDashboard('/api/bot/sync', {
      method: 'POST',
      body: JSON.stringify({ bot_status: { online: false } }),
    })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  }
  process.on('SIGTERM', goOffline);
  process.on('SIGINT', goOffline);
}

module.exports = { startDashboardSync };
