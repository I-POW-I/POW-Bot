const LEVELS = { 
  INFO:  '\x1b[32mINFO \x1b[0m', // Bright Green
  WARN:  '\x1b[33mWARN \x1b[0m', // Bright Yellow
  ERROR: '\x1b[31mERROR\x1b[0m', // Bright Red
  VOICE: '\x1b[35mVOICE\x1b[0m', // Bright Purple / Magenta
  GHOST: '\x1b[35mGHOST\x1b[0m', // Bright Purple / Magenta
  HEART: '\x1b[34mHEART\x1b[0m', // Bright Blue Tag
  AUDIT: '\x1b[36mAUDIT\x1b[0m'  // Cyan — deliberate changes (setup edits, owner actions, restarts)
};

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
  const lvl = LEVELS[level] || '\x1b[32mINFO \x1b[0m';
  const d = diag();
  const err = context.err instanceof Error ? context.err : null;

  // Work out the extra detail for problems
  let described = null;
  let triggerText = null;
  if (d && (level === 'ERROR' || level === 'WARN')) {
    if (err) described = d.describeError(err);
    triggerText = d.describeContext(d.currentContext());
  }

  // Build the grey key=value metadata (never print err/stack objects inline)
  const shown = Object.entries(context).filter(([k]) => k !== 'stack' && k !== 'err');
  if (described) {
    if (!shown.some(([k]) => k === 'error')) shown.push(['error', `${described.name}: ${described.message}`]);
    if (described.title) shown.push(['cause', described.title + (described.code != null ? ` (${described.code})` : '')]);
    if (described.origin) shown.push(['where', described.origin]);
    if (described.route) shown.push(['request', described.route]);
  }
  if (triggerText && !shown.some(([k]) => k === 'trigger')) shown.push(['trigger', triggerText]);

  const ctx = shown.length
    ? ' | ' + shown.map(([k, v]) => `\x1b[90m${k}=${v}\x1b[0m`).join(' | ')
    : '';
  
  // Custom multi-pipe separator exclusively for INFO logs
  const separator = (level === 'INFO') ? '|||' : '|';
  
  // Build the main payload line
  let body = `${separator} ${message}${ctx}`;
  
  // If it's a HEART log, wrap the entire remaining line in dimmed blue
  if (level === 'HEART') {
    // \x1b[2m = Dim, \x1b[34m = Blue, \x1b[0m = Reset color at the end
    body = `\x1b[2m\x1b[34m${body}\x1b[0m`;
  }
  
  const line = `${lvl} ${body}`;
  
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  // Stack: just OUR code's frames when we have an error object, otherwise any supplied stack text
  if (described?.frames?.length) {
    console.error(`\x1b[90m${d.consoleLines(described).join('\n')}\x1b[0m`);
  } else if (context.stack) {
    console.error(`\x1b[90m${String(context.stack).split('\n').slice(0, 8).join('\n')}\x1b[0m`);
  }

  // Breadcrumb timeline (skip the noisy heartbeat)
  // (AUDIT entries add their own, richer breadcrumb in diagnostics.audit)
  if (d && level !== 'HEART' && level !== 'AUDIT') d.addBreadcrumb(level.toLowerCase(), message);
  if (d && level === 'ERROR') d.noteError(message);
  if (d && level === 'WARN') d.bump('warnings');

  // Forward problems and changes to the alert channel/webhook/DM (no-op unless configured).
  if (level === 'ERROR' || level === 'WARN' || level === 'GHOST' || level === 'AUDIT') {
    try { require('./errorAlerts').capture(level, message, context); } catch (_) { /* never let alerting break logging */ }
  }
}

module.exports = { log };
