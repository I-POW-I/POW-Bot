/**
 * Message and reaction counts for "My Server Time Wrapped".
 *
 * Numbers only, never text: one row per member, day, hour (UTC) and channel holding how many messages and reactions they
 * sent. Nothing is counted unless the server switched it on in /setup > Wrapped, and only from that moment on.
 * Per-server settings live in the server's config under `wrapped`.
 */

const { run, selectAll, selectOne } = require('./database');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');

const DEFAULTS = { counting: false, countingSince: null, autoPost: false, channelId: null, day: 1, postedYear: null };

const settings = (guildId) => ({ ...DEFAULTS, ...(getGuildConfig(guildId).wrapped || {}) });
const setSettings = (guildId, patch) => setGuildConfig(guildId, { wrapped: { ...settings(guildId), ...patch } });
const counting = (guildId) => !!getGuildConfig(guildId).wrapped?.counting;

/** Turn counting on or off. The time it was first switched on is kept, so cards can say "counted since". */
function setCounting(guildId, on) {
  const s = settings(guildId);
  setSettings(guildId, { counting: !!on, countingSince: on ? (s.countingSince || Date.now()) : s.countingSince });
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function bump(guildId, userId, channelId, column, at = Date.now()) {
  run(`INSERT INTO activity (guild_id, user_id, day, hour, channel_id, messages, reactions) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, day, hour, channel_id) DO UPDATE SET ${column} = ${column} + 1`,
  [guildId, userId, dayOf(at), new Date(at).getUTCHours(), channelId, column === 'messages' ? 1 : 0, column === 'reactions' ? 1 : 0]);
}

/** A message was sent. Bots, direct messages and servers that did not opt in are ignored. */
function recordMessage(message) {
  if (!message?.guildId || message.author?.bot || message.webhookId || !counting(message.guildId)) return;
  bump(message.guildId, message.author.id, message.channelId, 'messages', message.createdTimestamp || Date.now());
}

/** A reaction was added by a member. */
function recordReaction(reaction, user) {
  const guildId = reaction?.message?.guildId;
  if (!guildId || !user || user.bot || !counting(guildId)) return;
  bump(guildId, user.id, reaction.message.channelId, 'reactions');
}

/** Delete every count stored for a server. */
function erase(guildId) {
  const n = Number(selectOne('SELECT COUNT(*) AS n FROM activity WHERE guild_id = ?', [guildId])?.n || 0);
  run('DELETE FROM activity WHERE guild_id = ?', [guildId]);
  setSettings(guildId, { countingSince: null });
  return n;
}

const rows = (sql, params) => selectAll(sql, params);

module.exports = { settings, setSettings, counting, setCounting, recordMessage, recordReaction, erase, dayOf, rows };
