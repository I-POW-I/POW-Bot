const LEVELS = { 
  INFO:  '\x1b[32mINFO \x1b[0m', // Bright Green
  WARN:  '\x1b[33mWARN \x1b[0m', // Bright Yellow
  ERROR: '\x1b[31mERROR\x1b[0m', // Bright Red
  VOICE: '\x1b[36mVOICE\x1b[0m', // Bright Cyan
  GHOST: '\x1b[35mGHOST\x1b[0m', // Bright Magenta
  HEART: '\x1b[34mHEART\x1b[0m'  // Bright Blue
};

function log(level, message, context = {}) {
  const lvl = LEVELS[level] || '\x1b[32mINFO \x1b[0m';
  
  // Grey out context fields metadata (like guild=Home) so they don't distract you
  const ctx = Object.keys(context).length
    ? ' | ' + Object.entries(context).map(([k, v]) => `\x1b[90m${k}=${v}\x1b[0m`).join(' | ')
    : '';
  
  // Custom multi-pipe separator exclusively for INFO logs
  const separator = (level === 'INFO') ? '|||' : '|';
  
  const line = `${lvl} ${separator} ${message}${ctx}`;
  
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

module.exports = { log };
