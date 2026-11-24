/**
 * What the bot keeps, for how long, and how it is removed.
 *
 *   Stored message text (deleted and edited message logs)   7 days          src/messageStore.js
 *   Member join and leave history                           90 days
 *   Voice and live stream stats                             kept until the bot leaves the server, unless the
 *                                                           server opts in to a yearly reset (/setup > Voice
 *                                                           leaderboard): on 1 January everything from before
 *                                                           the new year is deleted
 *   Everything about a server                               deleted when the bot is removed from it
 *   Everything about a person                               deleted on request with /privacy
 *
 * The same numbers are described in docs/PRIVACY.md. Change them in both places.
 */

const { run, selectAll, selectOne } = require('./database');
const { deleteGuildConfig } = require('./guildConfig');
const messageStore = require('./messageStore');
const globalConfig = require('./globalConfig');
const { log } = require('./logger');

const DAY = 86_400_000;
const KEEP = { memberEvents: 90 * DAY };
const EVERY = 6 * 3_600_000;
const GUILD_TABLES = ['vc_sessions', 'stream_sessions', 'member_events', 'message_store', 'streamer_subscriptions', 'game_subscriptions'];

// ── Removal ───────────────────────────────────────────────────────────────────

/** Everything stored for one server. Called when the bot is removed from it. */
function purgeGuild(guildId) {
  const id = String(guildId);
  for (const table of GUILD_TABLES) run(`DELETE FROM ${table} WHERE guild_id = ?`, [id]);
  deleteGuildConfig(id);
  globalConfig.update(s => { delete s.announce.lastChannels[id]; });
}

/** Everything stored about one person, in every server. */
function forgetUser(userId) {
  const id = String(userId);
  run('DELETE FROM vc_sessions WHERE user_id = ?', [id]);
  run('DELETE FROM stream_sessions WHERE user_id = ?', [id]);
  run('DELETE FROM member_events WHERE user_id = ?', [id]);
  run('DELETE FROM message_store WHERE author_id = ?', [id]);
}

/** What is stored about one person, for the /privacy screen. */
function userData(userId) {
  const id = String(userId);
  const n = (sql) => Number(selectOne(sql, [id])?.n || 0);
  return {
    voice:    n('SELECT COUNT(*) AS n FROM vc_sessions WHERE user_id = ?'),
    streams:  n('SELECT COUNT(*) AS n FROM stream_sessions WHERE user_id = ?'),
    events:   n('SELECT COUNT(*) AS n FROM member_events WHERE user_id = ?'),
    messages: n('SELECT COUNT(*) AS n FROM message_store WHERE author_id = ?'),
  };
}

// ── Ageing out ────────────────────────────────────────────────────────────────

/**
 * Servers that chose a yearly reset: on 1 January (UTC) the voice and live stats from before the new year are
 * deleted, so the leaderboard starts fresh. Runs on every sweep and is safe to repeat. Servers that did not
 * choose it are never touched.
 */
function yearlyReset(now = Date.now(), ids = null) {
  const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  const { getGuildConfig } = require('./guildConfig');
  const guilds = ids || [...new Set([...selectAll('SELECT DISTINCT guild_id FROM vc_sessions'), ...selectAll('SELECT DISTINCT guild_id FROM stream_sessions')].map(r => r.guild_id))];
  let reset = 0;
  for (const id of guilds) {
    if (!getGuildConfig(id).leaderboard?.yearlyReset) continue;
    run('DELETE FROM vc_sessions WHERE guild_id = ? AND duration_ms IS NOT NULL AND joined_at < ?', [id, yearStart]);
    run('DELETE FROM stream_sessions WHERE guild_id = ? AND duration_ms IS NOT NULL AND joined_at < ?', [id, yearStart]);
    reset++;
  }
  return reset;
}

function ageOut(now = Date.now()) {
  run('DELETE FROM member_events WHERE at < ?', [now - KEEP.memberEvents]);
  yearlyReset(now);
}

// ── Servers the bot is no longer in ───────────────────────────────────────────

let missingBefore = new Set();

/**
 * If the bot was removed while it was offline, no event fired. A server is only purged when it has been
 * missing from the bot's server list on two checks in a row, so a Discord outage can never wipe data.
 */
function purgeAbsent(client) {
  if (!client.guilds.cache.size) return 0;
  const known = new Set();
  for (const table of GUILD_TABLES) for (const r of selectAll(`SELECT DISTINCT guild_id FROM ${table}`)) known.add(r.guild_id);
  const missing = new Set([...known].filter(id => !client.guilds.cache.has(id)));
  const gone = [...missing].filter(id => missingBefore.has(id));
  missingBefore = missing;
  for (const id of gone) purgeGuild(id);
  if (gone.length) log('INFO', `Removed stored data for ${gone.length} server(s) the bot is no longer in`);
  return gone.length;
}

function start(client) {
  const timer = setInterval(() => {
    try { ageOut(); purgeAbsent(client); }
    catch (err) { log('WARN', 'Retention sweep failed', { err }); }
  }, EVERY);
  timer.unref?.();
  setTimeout(() => { try { ageOut(); } catch (err) { log('WARN', 'Retention sweep failed', { err }); } }, 60_000).unref?.();
}

module.exports = { KEEP, purgeGuild, forgetUser, userData, yearlyReset, ageOut, purgeAbsent, start, messageDays: messageStore.RETENTION_MS / DAY };
