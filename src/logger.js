/**
 * Console lines look like:   LEVEL | TAG | short sentence | details
 *
 * LEVEL is always one of Discloud's own six (trace, debug, info, warn, error, fatal), in the same colours its filter chips use,
 * so Discloud's level filters and search work on every line. TAG says which part of the bot spoke (HEART, VOICE, COMMAND…).
 * The older level names still work: HEART, VOICE and AUDIT are info lines with that tag, GHOST is a warning.
 */
const COLOUR = { TRACE: '90', DEBUG: '35', INFO: '34', WARN: '33', ERROR: '31', FATAL: '95' };
const LEGACY = { HEART: ['INFO', 'HEART'], VOICE: ['INFO', 'VOICE'], GHOST: ['WARN', 'HEART'], AUDIT: ['INFO', 'AUDIT'] };
const TAGS = [                                   // when no tag is given, it is worked out from the message
  [/^(Loaded command|Registered (event|\d+ global))/i, 'LOAD'], [/^(Error in|Command) \//i, 'COMMAND'], [/^\//, 'COMMAND'], [/^(Button|Modal|Menu)/i, 'UI'],
  [/bot status|status rotation/i, 'STATUS'], [/stream|twitch|kick|youtube|went live/i, 'STREAM'], [/game|patch|giveaway|epic|steam/i, 'GAMES'],
  [/voice|call|rejoin/i, 'VOICE'], [/panel|status/i, 'PANEL'], [/database|sqlite|backup|retention/i, 'DATA'],
  [/log(s| channel)|audit/i, 'LOGS'], [/alert|webhook|digest/i, 'ALERT'], [/setup/i, 'SETUP'],
];
const TAG_COLOUR = { HEART: '92', BOT: '37', LOAD: '90', VOICE: '36', COMMAND: '96', UI: '94', GAMES: '93', STREAM: '35', PANEL: '32', STATUS: '95', DATA: '34', LOGS: '1;37', SETUP: '1;36', ALERT: '33', AUDIT: '1;33' };
const tagFor = (message) => (TAGS.find(([re]) => re.test(String(message))) || [null, 'BOT'])[1];
const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

// diagnostics is required lazily so logger.js never fails to load because of it
function diag() { try { return require('./diagnostics'); } catch { return null; } }

/**
 * log(level, message, context)
 *
 * Pass the caught error as `err` for a proper report:
 *   log('ERROR', 'Could not post live message', { guild: g.name, err });
 * The console then shows what the error means, where in the code it happened and what
 * was being handled at the time, and the alert system gets the full picture.
 */
function log(level, message, context = {}) {
  const original = level;
  const [word, legacyTag] = LEGACY[level] || [COLOUR[level] ? level : 'INFO', null];
  const tag = context.tag || legacyTag || tagFor(message);
  const d = diag();
  const err = context.err instanceof Error ? context.err : null;

  // Work out the extra detail for problems
  let described = null;
  let triggerText = null;
  if (d && (word === 'ERROR' || word === 'WARN' || word === 'FATAL')) {
    if (err) described = d.describeError(err);
    triggerText = d.describeContext(d.currentContext());
  }

  // Details: who and where read as plain values, uptime as "up …", the rest as dim key=value
  const shown = Object.entries(context).filter(([k]) => !['stack', 'err', 'tag'].includes(k));
  if (described) {
    if (!shown.some(([k]) => k === 'error')) shown.push(['error', `${described.name}: ${described.message}`]);
    if (described.title) shown.push(['cause', described.title + (described.code != null ? ` (${described.code})` : '')]);
    if (described.origin) shown.push(['where', described.origin]);
    if (described.route) shown.push(['request', described.route]);
  }
  if (triggerText && !shown.some(([k]) => k === 'trigger')) shown.push(['trigger', triggerText]);

  const clip = (v) => { const t = String(v).replace(/\s+/g, ' '); return t.length > 240 ? `${t.slice(0, 239)}…` : t; };
  const PLAIN = ['guild', 'channel', 'user', 'game', 'streamer', 'platform', 'note'];
  const parts = shown.map(([k, v]) => PLAIN.includes(k) ? paint('37', clip(v)) : k === 'uptime' ? paint('37', `up ${clip(v)}`) : `${paint('90', `${k}=`)}${paint('37', clip(v))}`);
  const ctx = parts.length ? ` ${paint('90', '|')} ${parts.join(` ${paint('90', '|')} `)}` : '';

  const line = `${paint(COLOUR[word], word.padEnd(5))} ${paint('90', '|')} ${paint(TAG_COLOUR[tag] || '37', tag.padEnd(7))} ${paint('90', '|')} ${message}${ctx}`;

  if (word === 'ERROR' || word === 'FATAL') console.error(line);
  else if (word === 'WARN') console.warn(line);
  else console.log(line);

  // Stack: just OUR code's frames when we have an error object, otherwise any supplied stack text
  if (described?.frames?.length) {
    console.error(`\x1b[90m${d.consoleLines(described).join('\n')}\x1b[0m`);
  } else if (context.stack) {
    console.error(`\x1b[90m${String(context.stack).split('\n').slice(0, 8).join('\n')}\x1b[0m`);
  }

  // Breadcrumb timeline (skip the noisy heartbeat)
  // (AUDIT entries add their own, richer breadcrumb in diagnostics.audit)
  if (d && original !== 'HEART' && original !== 'AUDIT') d.addBreadcrumb(word.toLowerCase(), message);
  if (d && (word === 'ERROR' || word === 'FATAL')) d.noteError(message);
  if (d && word === 'WARN') d.bump('warnings');

  // Forward problems and changes to the alert channel/webhook/DM (no-op unless configured).
  if (original === 'ERROR' || original === 'FATAL' || original === 'WARN' || original === 'GHOST' || original === 'AUDIT') {
    try { require('./errorAlerts').capture(original === 'FATAL' ? 'ERROR' : original, message, context); } catch (_) { /* never let alerting break logging */ }
  }
}

module.exports = { log };
