/**
 * Run before pushing:  npm run check
 *
 * Loads every file the way the bot does and reports anything that would stop it starting:
 * syntax errors, missing files, a command without data/execute, an event without a name.
 * Nothing is connected to Discord and no data is written.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'logs', 'scripts', '_t']);
const failures = [];
let checked = 0;

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) files(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const fail = (file, message) => failures.push(`${rel(file)}: ${message}`);

for (const file of files(ROOT)) {
  checked++;
  if (path.basename(file) === 'index.js' && path.dirname(file) === ROOT) {
    try { new (require('vm').Script)(fs.readFileSync(file, 'utf8'), { filename: file }); } catch (err) { fail(file, err.message); }   // index.js starts the bot, so it is only parsed
    continue;
  }
  let mod;
  try { mod = require(file); } catch (err) { fail(file, err.message.split('\n')[0]); continue; }
  const dir = path.basename(path.dirname(file));
  if (dir === 'commands') {
    if (!mod?.data?.name || typeof mod.execute !== 'function') fail(file, 'a command needs `data` and `execute`');
    else { try { mod.data.toJSON(); } catch (err) { fail(file, `the command definition is invalid: ${err.message}`); } }
  }
  if (dir === 'events' && (!mod?.name || typeof mod.execute !== 'function')) fail(file, 'an event needs `name` and `execute`');
}

for (const name of ['BOT_TOKEN', 'CLIENT_ID']) if (!process.env[name]) console.log(`note: ${name} is not set here. That is fine for this check; the host provides it.`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s) in ${checked} files:\n${failures.map(f => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`All ${checked} files load. Safe to push.`);
process.exit(0);
