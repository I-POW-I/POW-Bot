/*
 * POW Bot — modified index.js with dashboard module integration
 *
 * It preserves ALL existing voice/24-7 logic and adds the five dashboard
 * feature modules (automod, custom commands, reaction roles, tickets, webhooks),
 * plus the dashboard heartbeat/command sync (src/dashboardSync.js).
 */

const { loadCommands, loadEvents } = require('./src/registry');
const { log } = require('./src/logger');
const client = require('./src/client');
const { startDashboardSync } = require('./src/dashboardSync');
const http = require('http');
require('dotenv').config();

// ── Existing env checks (unchanged) ──────────────────────────────────────────
if (!process.env.BOT_TOKEN) {
  log('ERROR', 'Missing BOT_TOKEN in .env — cannot start.');
  process.exit(1);
}
if (!process.env.CLIENT_ID) {
  log('ERROR', 'Missing CLIENT_ID in .env — cannot start.');
  process.exit(1);
}

// ── Load existing commands and events (unchanged) ────────────────────────────
loadCommands(client);
loadEvents(client);

// ── Register dashboard feature modules (automod, custom commands, reaction
//    roles, tickets, webhooks) ────────────────────────────────────────────────
// IMPORTANT: `require('./bot-modules')` is deliberately done in here, INSIDE
// the env check, not at the top of the file. bot-modules/supabase-client.js
// throws synchronously if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing,
// and every module in bot-modules/ requires it at load time. If that require
// happened at the top of this file (as it did before), a missing or mistyped
// Supabase env var would crash the ENTIRE bot before it even logs in to
// Discord — not just disable the dashboard modules. The try/catch below is a
// second layer of safety: even a bug inside one of the modules can no longer
// take the whole bot down with it.
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const botModules = require('./bot-modules');
    botModules.register(client);
    log('INFO', 'Dashboard feature modules registered (automod, custom commands, reaction roles, tickets, webhooks).');
  } catch (err) {
    log('ERROR', 'Dashboard feature modules failed to load — bot continuing without them.', { error: err.message });
  }
} else {
  log('WARN', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — dashboard modules will be disabled.');
  log('WARN', 'Add them to .env to enable automod, custom commands, reaction roles, tickets, webhooks.');
}

// ── Dashboard heartbeat + remote command polling (new) ───────────────────────
// Pushes online/ping/guild-count to the dashboard every 60s and polls for
// queued commands (restart, presence, sync, refresh_status) every 15s.
// Needs DASHBOARD_URL + BOT_API_TOKEN — see src/dashboardSync.js.
startDashboardSync(client);

// ── Optional: bot HTTP server — webhook triggers + live guild data ───────────
// Lets the dashboard's "Test webhook" button fire through the bot, and lets
// the dashboard fetch a guild's real channels/roles instead of showing
// placeholder data. Runs on BOT_HTTP_PORT (default 8081). Only starts if
// BOT_API_TOKEN is set.
if (process.env.BOT_API_TOKEN) {
  try {
    const { handleHttpTrigger } = require('./bot-modules/webhooks');
    const { handleGuildDataRequest } = require('./src/guildDataApi');
    const port = parseInt(process.env.BOT_HTTP_PORT || '8081', 10);
    const server = http.createServer(async (req, res) => {
      if (req.url?.startsWith('/webhooks/trigger')) return handleHttpTrigger(req, res);
      if (await handleGuildDataRequest(req, res, client)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    server.listen(port, () => {
      log('INFO', `Bot HTTP server listening on port ${port} (webhook triggers + live guild data)`);
    });
  } catch (err) {
    log('WARN', 'Bot HTTP server not started.', { error: err.message });
  }
}

// ── Login (unchanged) ────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN);

// ── Error handlers (unchanged) ───────────────────────────────────────────────
process.on('unhandledRejection', (error) => {
  log('ERROR', 'Unhandled promise rejection', { message: error.message });
});
process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught exception', { message: error.message });
});
