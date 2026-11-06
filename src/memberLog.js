/**
 * Member history — a timeline of what happened to every member of every server:
 * joins, leaves, verification results, staff actions, raids.
 *
 * Table: member_events (guild_id, user_id, event, at, data JSON)
 * Events: join · leave · verify_ok · verify_fail · verify_blocked · approved · kicked_unverified · raid
 *
 * Only information Discord itself provides about the account is ever recorded
 * (account age, flags, join/leave times, verification outcome) — no emails, no IP addresses.
 */

const { run, selectAll, selectOne } = require('./database');

function record(guildId, userId, event, data = {}) {
  run('INSERT INTO member_events (guild_id, user_id, event, at, data) VALUES (?, ?, ?, ?, ?)',
    [String(guildId), String(userId), event, Date.now(), JSON.stringify(data)]);
}

const parse = (row) => row && { ...row, data: (() => { try { return JSON.parse(row.data || '{}'); } catch { return {}; } })() };

/** Everything that happened to one member in one server, newest first. */
function history(guildId, userId, limit = 25) {
  return selectAll('SELECT * FROM member_events WHERE guild_id = ? AND user_id = ? ORDER BY at DESC LIMIT ?', [String(guildId), String(userId), limit]).map(parse);
}

/** Latest events for a server (optionally only certain event types). */
function recent(guildId, limit = 10, events = null) {
  const filter = events?.length ? ` AND event IN (${events.map(() => '?').join(',')})` : '';
  return selectAll(`SELECT * FROM member_events WHERE guild_id = ?${filter} ORDER BY at DESC LIMIT ?`, [String(guildId), ...(events || []), limit]).map(parse);
}

/** How many of an event happened since a time. */
function count(guildId, event, sinceMs = 0) {
  return selectOne('SELECT COUNT(*) AS n FROM member_events WHERE guild_id = ? AND event = ? AND at >= ?', [String(guildId), event, sinceMs])?.n || 0;
}

/** Number of times this user has joined / left before. */
function priorCounts(guildId, userId) {
  const row = (event) => selectOne('SELECT COUNT(*) AS n, MAX(at) AS last FROM member_events WHERE guild_id = ? AND user_id = ? AND event = ?', [String(guildId), String(userId), event]) || {};
  const j = row('join'), l = row('leave');
  return { joins: j.n || 0, leaves: l.n || 0, lastLeft: l.last || null, everVerified: (row('verify_ok').n || 0) + (row('approved').n || 0) > 0 };
}

/** Funnel for a period: joined → verified (+ failed / blocked / kicked). */
function funnel(guildId, sinceMs) {
  const n = (e) => count(guildId, e, sinceMs);
  return { joined: n('join'), left: n('leave'), verified: n('verify_ok') + n('approved'), failed: n('verify_fail'), blocked: n('verify_blocked'), kicked: n('kicked_unverified'), raids: n('raid') };
}

module.exports = { record, history, recent, count, priorCounts, funnel };
