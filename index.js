// Load .env / Discloud variables FIRST so every module sees them at require time
require('dotenv').config();

const { loadCommands, loadEvents } = require('./src/registry');
const { log } = require('./src/logger');
const client = require('./src/client');
const alerts = require('./src/errorAlerts');
const { flush: flushDatabase } = require('./src/database');

if (!process.env.BOT_TOKEN) {
  log('ERROR', 'Missing BOT_TOKEN in .env — cannot start.');
  process.exit(1);
}

if (!process.env.CLIENT_ID) {
  log('ERROR', 'Missing CLIENT_ID in .env — cannot start.');
  process.exit(1);
}

/** Anything can be thrown — make sure we always have a real Error to analyse. */
const toError = (e) => {
  if (e instanceof Error) return e;
  let text; try { text = typeof e === 'string' ? e : JSON.stringify(e); } catch { text = String(e); }
  return new Error(text);
};

alerts.init(client);
loadCommands(client);
loadEvents(client);

// ── Discord client problems ───────────────────────────────────────────────────

client.on('error', (error) => {
  log('ERROR', 'Discord client error', { err: toError(error) });
});

client.on('shardError', (error, shardId) => {
  log('ERROR', 'Discord shard error', { shard: shardId, err: toError(error) });
});

// The gateway session was invalidated and discord.js gave up — exit so the host
// (Discloud AUTORESTART) starts a fresh process instead of leaving a dead bot online.
client.on('invalidated', () => {
  log('ERROR', 'Discord session invalidated — restarting process');
  shutdown('session invalidated', 1);
});

client.login(process.env.BOT_TOKEN);

// ── Crash safety nets ─────────────────────────────────────────────────────────
// Catch unhandled errors so the bot doesn't silently die

process.on('unhandledRejection', (error) => {
  log('ERROR', 'Unhandled promise rejection', { err: toError(error) });
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught exception (the bot kept running)', { err: toError(error) });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Discloud stops/restarts the app with SIGTERM. Save the database first so the
// last couple of seconds of VC activity aren't lost, and tell the alert channel.

let shuttingDown = false;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { flushDatabase(); } catch (_) {}
  try { await alerts.notifyShutdown(reason); } catch (_) {}
  try { client.destroy(); } catch (_) {}
  process.exit(code);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));