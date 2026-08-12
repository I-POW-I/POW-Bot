const LEVELS = { 
  INFO:  '\x1b[32mINFO \x1b[0m', // Bright Green
  WARN:  '\x1b[33mWARN \x1b[0m', // Bright Yellow
  ERROR: '\x1b[31mERROR\x1b[0m', // Bright Red
  VOICE: '\x1b[35mVOICE\x1b[0m', // Bright Purple / Magenta
  GHOST: '\x1b[35mGHOST\x1b[0m', // Bright Purple / Magenta
  HEART: '\x1b[34mHEART\x1b[0m'  // Bright Blue Tag
};

function log(level, message, context = {}) {
  const lvl = LEVELS[level] || '\x1b[32mINFO \x1b[0m';
  
  // Grey out context fields metadata (like guild=Home) so they don't distract you
  const ctx = Object.keys(context).length
    ? ' | ' + Object.entries(context).map(([k, v]) => `\x1b[90m${k}=${v}\x1b[0m`).join(' | ')
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
}

module.exports = { log };
