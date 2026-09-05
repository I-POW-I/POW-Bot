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

    log('INFO', 'SQLite database ready (data/pow-bot.db)');
  } catch (err) {
    log('ERROR', 'SQLite init failed — tracking unavailable', { error: err.message });
    db = null;
  }
}

function save() {
  if (!db) return;
  try {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  } catch (err) {
    log('ERROR', 'DB save failed', { error: err.message });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function run(sql, params = []) {
  if (!db) return;
  try {
    const stmt = db.prepare(sql);
    stmt.run(params);
    stmt.free();
    save();
  } catch (err) {
    log('ERROR', 'DB run failed', { error: err.message, sql: sql.slice(0, 80) });
  }
}

function selectOne(sql, params = []) {
  if (!db) return null;
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  } catch (err) {
    log('ERROR', 'DB selectOne failed', { error: err.message });
    return null;
  }
}

function selectAll(sql, params = []) {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (err) {
    log('ERROR', 'DB selectAll failed', { error: err.message });
    return [];
  }
}

// ── Streak helper ─────────────────────────────────────────────────────────────

function calcStreak(userId, guildId) {
  const rows = selectAll(
    `SELECT DISTINCT date(joined_at / 1000, 'unixepoch') AS day
     FROM vc_sessions
     WHERE user_id = ? AND guild_id = ? AND duration_ms IS NOT NULL
     ORDER BY day DESC`,
    [userId, guildId]
  );
  if (rows.length === 0) return 0;
  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (rows[0].day !== today && rows[0].day !== yesterday) return 0;
  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const diff = Math.round((new Date(rows[i-1].day) - new Date(rows[i].day)) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
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

module.exports = {
  init, run, selectOne, selectAll,
  startSession, endSession, getOpenSession,
  getUserStats, getServerTotals, formatMs,
};
