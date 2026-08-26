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
const { setCustomPresence } = require('./statusUpdater');

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

async function markCommand(id, status, errorMessage) {
  try {
    await callDashboard(`/api/bot/commands/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(errorMessage ? { error_message: errorMessage } : {}) }),
    });
  } catch (err) {
    log('WARN', `Failed to mark bot_command ${id} as ${status}`, { error: err.message });
  }
}

const PRESENCE_TYPE_MAP = {
  Playing: 0,   // ActivityType.Playing
  Watching: 3,  // ActivityType.Watching
  Listening: 2, // ActivityType.Listening
  Custom: 4,    // ActivityType.Custom
};

async function applyPresenceCommand(client, payload) {
  const type = payload?.type || 'Custom';
  const text = (payload?.text || '').slice(0, 128);
  if (!text) throw new Error('Presence command missing text');

  const activityType = PRESENCE_TYPE_MAP[type] ?? PRESENCE_TYPE_MAP.Custom;
  const activity =
    activityType === PRESENCE_TYPE_MAP.Custom
      ? { name: 'Custom Status', state: text, type: activityType }
      : { name: text, type: activityType };

  // Pin this presence so the 20s status-rotation loop in statusUpdater.js
  // doesn't immediately overwrite it — matches what the dashboard UI already
  // tells the user ("Setting a custom presence overrides the rotation").
  setCustomPresence(activity);
  client.user.setPresence({ status: 'online', activities: [activity] });
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

    default:
      await markCommand(cmd.id, 'failed', `Unknown command: ${cmd.command}`);
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
        await markCommand(cmd.id, 'failed', err.message);
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
