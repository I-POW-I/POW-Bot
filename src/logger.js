const LEVELS = { INFO: 'INFO ', WARN: 'WARN ', ERROR: 'ERROR', VOICE: 'VOICE', GHOST: 'GHOST', HEART: 'HEART' };

function log(level, message, context = {}) {
  const lvl = LEVELS[level] || 'INFO ';
  const ctx = Object.keys(context).length
    ? ' | ' + Object.entries(context).map(([k, v]) => `${k}=${v}`).join(' | ')
    : '';
  
  // Removed the [${ts}] known as date and time part to let Discloud handle the timestamping
  const line = `${lvl} | ${message}${ctx}`;
  
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

module.exports = { log };
