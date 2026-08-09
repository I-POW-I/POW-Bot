/*
 * POW Bot — modified index.js with dashboard module integration
 *
 * Drop this file into your bot repo root, replacing the existing index.js.
 * It preserves ALL existing voice/24-7 logic and adds the five dashboard
 * feature modules (automod, custom commands, reaction roles, tickets, webhooks).
 */

const { loadCommands, loadEvents } = require('./src/registry');
const { log } = require('./src/logger');
const client = require('./src/client');
const botModules = require('./bot-modules');
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

// ── Supabase env check (new — only needed for dashboard modules) ─────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  log('WARN', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — dashboard modules will be disabled.');
  log('WARN', 'Add them to .env to enable automod, custom commands, reaction roles, tickets, webhooks.');
}

// ── Load existing commands and events (unchanged) ────────────────────────────
loadCommands(client);
loadEvents(client);

// ── Register dashboard feature modules (new) ─────────────────────────────────
// Only register if Supabase env vars are present, so the bot still runs
// without them during initial testing.
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  botModules.register(client);
  log('INFO', 'Dashboard feature modules registered (automod, custom commands, reaction roles, tickets, webhooks).');
} else {
  log('WARN', 'Dashboard feature modules skipped — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable.');
}

// ── Optional: webhook HTTP trigger server (new) ──────────────────────────────
// Lets the dashboard's "Test webhook" button fire through the bot.
// Runs on BOT_HTTP_PORT (default 8081). Only starts if BOT_API_TOKEN is set.
if (process.env.BOT_API_TOKEN) {
  const { handleHttpTrigger } = require('./bot-modules/webhooks');
  const port = parseInt(process.env.BOT_HTTP_PORT || '8081', 10);
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/webhooks/trigger')) return handleHttpTrigger(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  server.listen(port, () => {
    log('INFO', `Webhook HTTP trigger listening on port ${port}`);
  });
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
