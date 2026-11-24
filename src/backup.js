/**
 * Weekly backup of the whole application, sent to the bot owner's DMs as one zip.
 *
 * Included: the code, package.json and the data folder (database and settings).
 * Left out: .env files (secrets), node_modules (reinstalled from package.json), .git, logs and old backups.
 * Discord limits how big a file can be, so if the full backup is too large the data folder is sent on its own.
 *
 * The zip is written here directly (no extra dependency): files are deflated and listed in the standard ZIP layout.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const globalConfig = require('./globalConfig');
const { ownerIds } = require('./permissions');
const { flush } = require('./database');
const { log } = require('./logger');

const ROOT = path.join(__dirname, '..');
const EVERY_MS = 7 * 86_400_000;
const LIMIT = 9 * 1024 * 1024;   // Discord's default upload limit is 10 MiB
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'backups']);
const skipFile = (name) => name === '.env' || name.startsWith('.env.') || name.endsWith('.tmp') || name.endsWith('.log') || name === '.DS_Store';

/** Every file under `dir` as { rel, full }. */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), base, out); }
    else if (entry.isFile() && !skipFile(entry.name)) out.push({ rel: path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/'), full: path.join(dir, entry.name) });
  }
  return out;
}

function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** Build a zip from [{ name, data }]. */
function makeZip(files, when = new Date()) {
  const { time, date } = dosTime(when);
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), packed = zlib.deflateRawSync(f.data), crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(f.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const collect = (dir) => walk(dir).map(f => ({ name: f.rel, data: fs.readFileSync(f.full) }));

/** The backup as a buffer. Falls back to the data folder alone when the whole thing is too big. */
function build() {
  try { flush(); } catch { /* the database is saved again below if needed */ }
  let files = collect(ROOT), scope = 'the whole application';
  let zip = makeZip(files);
  if (zip.length > LIMIT) {
    files = collect(path.join(ROOT, 'data')); scope = 'the data folder only (the full backup was over Discord\'s upload limit)';
    zip = makeZip(files);
  }
  return { zip, scope, count: files.length };
}

const stamp = (d = new Date()) => d.toISOString().slice(0, 10);

/** Build a backup and send it to every owner. Returns { ok, error?, size?, scope? }. */
async function run(client) {
  const owners = ownerIds();
  if (!owners.length) return { ok: false, error: 'No owner is set (OWNER_IDS).' };
  try {
    const { zip, scope, count } = build();
    if (zip.length > LIMIT) throw new Error(`Even the data folder is ${(zip.length / 1048576).toFixed(1)} MB, over Discord's upload limit.`);
    let delivered = 0;
    for (const id of owners) {
      try {
        const user = await client.users.fetch(id);
        await user.send({ content: `Weekly backup: ${scope}, ${count} files. .env is not included.`, files: [{ attachment: zip, name: `pow-bot-backup-${stamp()}.zip` }] });
        delivered++;
      } catch (err) { log('WARN', 'Could not send the backup to an owner (are DMs open?)', { owner: id, err }); }
    }
    if (!delivered) throw new Error('Discord would not deliver it: check that your DMs are open to this bot.');
    globalConfig.update(s => { s.backup = { lastAt: Date.now(), size: zip.length, scope, error: null }; });
    log('INFO', 'Backup sent', { size: zip.length, files: count });
    return { ok: true, size: zip.length, scope };
  } catch (err) {
    globalConfig.update(s => { s.backup = { ...(s.backup || {}), error: err.message, failedAt: Date.now() }; });
    log('WARN', 'Backup failed', { err });
    return { ok: false, error: err.message };
  }
}

/** One check an hour; a backup goes out when the last one is more than a week old. */
function start(client) {
  const check = () => {
    const last = globalConfig.get().backup?.lastAt || 0, failed = globalConfig.get().backup?.failedAt || 0;
    if (Date.now() - last >= EVERY_MS && Date.now() - failed >= 6 * 3_600_000) run(client).catch(() => {});
  };
  setTimeout(check, 5 * 60_000).unref?.();
  setInterval(check, 3_600_000).unref?.();
}

module.exports = { makeZip, build, run, start, stamp, EVERY_MS };
