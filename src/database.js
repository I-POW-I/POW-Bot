/**
 * SQLite database using sql.js — pure JavaScript, no native compilation needed.
 * DB file: data/pow-bot.db
 *
 * Tables:
 *   vc_sessions            — VC time tracking per user
 *   streamer_subscriptions — streamer live notification config
 */

const path    = require('path');
const fs      = require('fs');
const { log } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'pow-bot.db');

let db = null;

async function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  try {
    const initSqlJs = require('sql.js');
    const SQL       = await initSqlJs();

    db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS vc_sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      TEXT    NOT NULL,
        guild_id     TEXT    NOT NULL,
        channel_id   TEXT    NOT NULL,
        channel_name TEXT    NOT NULL,
        joined_at    INTEGER NOT NULL,
        left_at      INTEGER,
        duration_ms  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_user_guild ON vc_sessions (user_id, guild_id);
      CREATE INDEX IF NOT EXISTS idx_guild      ON vc_sessions (guild_id);
      CREATE INDEX IF NOT EXISTS idx_joined     ON vc_sessions (joined_at);

      CREATE TABLE IF NOT EXISTS stream_sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      TEXT    NOT NULL,
        guild_id     TEXT    NOT NULL,
        joined_at    INTEGER NOT NULL,
        left_at      INTEGER,
        duration_ms  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_stream_user_guild ON stream_sessions (user_id, guild_id);

      CREATE TABLE IF NOT EXISTS member_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        event     TEXT    NOT NULL,
        at        INTEGER NOT NULL,
        data      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_member_events_guild ON member_events (guild_id, at);
      CREATE INDEX IF NOT EXISTS idx_member_events_user  ON member_events (guild_id, user_id);

      CREATE TABLE IF NOT EXISTS streamer_subscriptions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id            TEXT    NOT NULL,
        platform            TEXT    NOT NULL,
        username            TEXT    NOT NULL,
        display_name        TEXT,
        discord_channel_id  TEXT    NOT NULL,
        role_id             TEXT,
        is_live             INTEGER DEFAULT 0,
        last_message_id     TEXT,
        last_went_live      INTEGER,
        last_stream_title   TEXT,
        last_updated_at     INTEGER,
        UNIQUE(guild_id, platform, username)
      );
      CREATE INDEX IF NOT EXISTS idx_sub_platform ON streamer_subscriptions (platform);
      CREATE INDEX IF NOT EXISTS idx_sub_guild    ON streamer_subscriptions (guild_id);

      CREATE TABLE IF NOT EXISTS game_subscriptions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        app_id       TEXT    NOT NULL,
        game_name    TEXT,
        channel_id   TEXT    NOT NULL,
        role_id      TEXT,
        last_post_id TEXT,
        color        INTEGER,
        UNIQUE(guild_id, app_id)
      );
      CREATE INDEX IF NOT EXISTS idx_game_guild ON game_subscriptions (guild_id);

      CREATE TABLE IF NOT EXISTS game_subscriptions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        app_id       TEXT    NOT NULL,
        game_name    TEXT,
        channel_id   TEXT    NOT NULL,
        role_id      TEXT,
        last_post_id TEXT,
        color        INTEGER,
        UNIQUE(guild_id, app_id)
      );
      CREATE INDEX IF NOT EXISTS idx_game_guild ON game_subscriptions (guild_id);
    `);

    save();

    // Migrate existing tables — add columns that may not exist yet
    const migrations = [
      'ALTER TABLE streamer_subscriptions ADD COLUMN last_updated_at INTEGER',
      'ALTER TABLE game_subscriptions ADD COLUMN color INTEGER',
      'ALTER TABLE game_subscriptions ADD COLUMN color INTEGER',
    ];
    for (const m of migrations) {
      try { db.run(m); save(); } catch (_) { /* column already exists */ }
    }

    flush();  // write the schema to disk immediately (later writes are batched)

    log('INFO', 'SQLite database ready (data/pow-bot.db)');
  } catch (err) {
    log('ERROR', 'SQLite init failed — tracking unavailable', { err });
    db = null;
  }
}

// Saving used to export + rewrite the WHOLE database file on every single write
// (≈10 ms and an 8 MB+ copy each time on a busy server, blocking the event loop).
// Writes are now batched: the first write schedules one save a moment later, and
// the file is written to a temp file then renamed so a crash mid-write can never
// leave a half-written database behind.
const SAVE_DELAY_MS = 2000;
let saveTimer = null;
let dirty     = false;

function save() {
  if (!db) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

/** Write pending changes to disk immediately. Call on shutdown. */
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!db || !dirty) return;
  dirty = false;
  try {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    dirty = true; // try again on the next write / shutdown
    log('ERROR', 'DB save failed', { err });
  }
}

process.on('exit', flush);

// ── Internal helpers ──────────────────────────────────────────────────────────

function run(sql, params = []) {
  if (!db) return;
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.run(params);
    save();
  } catch (err) {
    log('ERROR', 'DB run failed', { err, sql: sql.slice(0, 80) });
  } finally {
    if (stmt) stmt.free();   // always — a failed query used to leak its statement
  }
}

function selectOne(sql, params = []) {
  if (!db) return null;
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : null;
  } catch (err) {
    log('ERROR', 'DB selectOne failed', { err });
    return null;
  } finally {
    if (stmt) stmt.free();
  }
}

function selectAll(sql, params = []) {
  if (!db) return [];
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } catch (err) {
    log('ERROR', 'DB selectAll failed', { err });
    return [];
  } finally {
    if (stmt) stmt.free();
  }
}

// ── Streak helper ─────────────────────────────────────────────────────────────
//
// A "streak" is the number of consecutive days (ending today, or yesterday if the
// person hasn't been in voice yet today) on which they spent time in voice.
//
// Previously a day only counted if a *finished* session had *started* on it, so
// the streak reset to 0 for anyone whose call ran past midnight, who stayed in
// voice for more than a day, or who was still in a call that began yesterday.
// Now every day a session overlaps counts, and a session that is still open counts
// up to today — but only if the person really is in voice right now.
//
// Day boundaries use UTC by default; set STREAK_TIMEZONE (e.g. Europe/London) in
// .env to roll the day over at local midnight instead.

const MAX_SESSION_DAYS     = 400;  // sanity cap for one finished session
const MAX_LIVE_OPEN_DAYS   = 14;   // an open session credits at most the last 14 days up to today

let dayFormatter = null;

function getDayFormatter() {
  if (dayFormatter) return dayFormatter;
  const make = (timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const tz = process.env.STREAK_TIMEZONE || 'UTC';
  try {
    dayFormatter = make(tz);
  } catch {
    log('WARN', `Invalid STREAK_TIMEZONE "${tz}" — falling back to UTC`);
    dayFormatter = make('UTC');
  }
  return dayFormatter;
}

/** Calendar-day index (days since epoch) of a timestamp, in the streak timezone. */
function dayNumber(ms) {
  const parts = {};
  for (const p of getDayFormatter().formatToParts(ms)) parts[p.type] = p.value;
  return Math.floor(Date.UTC(+parts.year, +parts.month - 1, +parts.day) / 86400000);
}

/** Is this user connected to a voice channel in this guild right now? */
function isInVoiceNow(userId, guildId) {
  try {
    const guild = require('./client').guilds.cache.get(guildId);
    return !!guild?.voiceStates?.cache.get(userId)?.channelId;
  } catch {
    return false;
  }
}

function calcStreak(userId, guildId) {
  const rows = selectAll(
    'SELECT joined_at, left_at FROM vc_sessions WHERE user_id = ? AND guild_id = ?',
    [userId, guildId]
  );
  if (rows.length === 0) return 0;

  const now = Date.now();

  // Only the newest unfinished row can be a real, current session. Older unfinished
  // rows are leftovers from a crash/restart and must not be stretched up to today.
  let newestOpen = -1;
  for (const r of rows) if (r.left_at == null && r.joined_at > newestOpen) newestOpen = r.joined_at;
  const liveNow = newestOpen >= 0 && isInVoiceNow(userId, guildId);

  const days = new Set();
  for (const r of rows) {
    let end   = r.left_at;
    let first = dayNumber(r.joined_at);

    if (end == null) {
      if (!(liveNow && r.joined_at === newestOpen)) continue;  // stale leftover — ignore
      end   = now;
      first = Math.max(first, dayNumber(now) - MAX_LIVE_OPEN_DAYS);
    }

    const last = Math.min(dayNumber(Math.max(end, r.joined_at)), first + MAX_SESSION_DAYS);
    for (let d = first; d <= last; d++) days.add(d);
  }

  const today = dayNumber(now);
  let cursor  = days.has(today) ? today : today - 1;   // not in voice yet today? yesterday still counts
  let streak  = 0;
  while (days.has(cursor)) { streak++; cursor--; }
  return streak;
}

// ── Public API ────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalS = Math.floor(ms / 1000);
  const d = Math.floor(totalS / 86400);
  const h = Math.floor((totalS % 86400) / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function startSession(userId, guildId, channelId, channelName) {
  run(
    'INSERT INTO vc_sessions (user_id, guild_id, channel_id, channel_name, joined_at) VALUES (?, ?, ?, ?, ?)',
    [userId, guildId, channelId, channelName, Date.now()]
  );
}

function endSession(userId, guildId) {
  const now  = Date.now();
  const open = selectOne(
    'SELECT id FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1',
    [userId, guildId]
  );
  if (!open) return;
  run('UPDATE vc_sessions SET left_at = ?, duration_ms = ? - joined_at WHERE id = ?', [now, now, open.id]);
}

function getOpenSession(userId, guildId) {
  return selectOne(
    'SELECT id, joined_at, channel_id, channel_name FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1',
    [userId, guildId]
  );
}

function getUserStats(userId, guildId) {
  const base = selectOne(
    `SELECT COUNT(*) AS session_count, COALESCE(SUM(duration_ms),0) AS total_ms,
            COALESCE(AVG(duration_ms),0) AS avg_ms, COALESCE(MAX(duration_ms),0) AS longest_session_ms,
            MAX(left_at) AS last_seen
     FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND duration_ms IS NOT NULL`,
    [userId, guildId]
  ) || { session_count: 0, total_ms: 0, avg_ms: 0, longest_session_ms: 0, last_seen: null };

  const top = selectOne(
    `SELECT channel_name, SUM(duration_ms) AS total_ms FROM vc_sessions
     WHERE user_id = ? AND guild_id = ? AND duration_ms IS NOT NULL
     GROUP BY channel_id ORDER BY total_ms DESC LIMIT 1`,
    [userId, guildId]
  );

  return { ...base, top_channel: top?.channel_name || null, top_channel_ms: top?.total_ms || 0, streak: calcStreak(userId, guildId) };
}

function getServerTotals(guildId) {
  return selectOne(
    'SELECT COUNT(*) AS total_sessions, COALESCE(SUM(duration_ms),0) AS total_ms FROM vc_sessions WHERE guild_id = ? AND duration_ms IS NOT NULL',
    [guildId]
  ) || { total_sessions: 0, total_ms: 0 };
}

function startStreamSession(userId, guildId) {
  run(
    'INSERT INTO stream_sessions (user_id, guild_id, joined_at) VALUES (?, ?, ?)',
    [userId, guildId, Date.now()]
  );
}

function endStreamSession(userId, guildId) {
  const now  = Date.now();
  const open = selectOne(
    'SELECT id FROM stream_sessions WHERE user_id = ? AND guild_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1',
    [userId, guildId]
  );
  if (!open) return;
  run('UPDATE stream_sessions SET left_at = ?, duration_ms = ? - joined_at WHERE id = ?', [now, now, open.id]);
}

function getStreamStats(userId, guildId) {
  return selectOne(
    `SELECT COALESCE(MAX(duration_ms),0) AS longest_stream_ms
     FROM stream_sessions WHERE user_id = ? AND guild_id = ? AND duration_ms IS NOT NULL`,
    [userId, guildId]
  ) || { longest_stream_ms: 0 };
}

module.exports = {
  init, flush, run, selectOne, selectAll,
  startSession, endSession, getOpenSession,
  getUserStats, getServerTotals, formatMs,
  startStreamSession, endStreamSession, getStreamStats,
};
