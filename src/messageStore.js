/**
 * Message store — what makes the deleted / edited message logs reliable.
 *
 * Discord does not tell a bot what a deleted message said, and discord.js only remembers the last
 * 200 messages per channel in memory (gone after every restart). So, in servers that have a
 * "Message logs" channel set in /setup, new messages are kept in the database for 7 days.
 *
 *  • only servers with a Message log channel set (nothing is stored anywhere else)
 *  • never webhooks, never the log channel itself
 *  • messages from other bots only when the server turns on "Log deleted bot messages" in /setup (never this bot's own)
 *  • a message is removed as soon as its deletion has been logged
 *  • everything older than 7 days is deleted automatically (hourly), plus a hard row cap
 *  • clearing the Message log channel in /setup (or the bot leaving) deletes that server's rows
 */

const { run, selectOne } = require('./database');
const { getLogChannel, getGuildConfig } = require('./guildConfig');

const RETENTION_MS = 7 * 24 * 3600_000;
const MAX_ROWS     = 50_000;
const MAX_CONTENT  = 4000;

/** Does this server log messages deleted by other bots? (off unless switched on in /setup) */
const botLoggingOn = (guildId) => getGuildConfig(guildId).logBotMessages === true;

const isOwnMessage = (message) => !!message.client?.user && message.author?.id === message.client.user.id;

/** Whether a message from a bot should be kept and logged. */
const wantsBot = (message) => !!message.author?.bot && !message.webhookId && !isOwnMessage(message) && !!message.guild && botLoggingOn(message.guild.id);

function shouldStore(message) {
  if (!message.guild || !message.author || message.webhookId) return false;
  if (message.author.bot && !wantsBot(message)) return false;
  const logChannel = getLogChannel(message.guild.id, 'messages');
  return !!logChannel && message.channelId !== logChannel;
}

/** Bots mostly post embeds, so keep a short text version of them. */
function describe(message) {
  const parts = (message.embeds || []).slice(0, 2).map(e => [e.title, e.description, ...(e.fields || []).slice(0, 4).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join(' · ')).filter(Boolean);
  return parts.length ? `Embed: ${parts.join(' | ')}`.slice(0, 1000) : '';
}

const attachmentsOf = (message) => [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url, type: a.contentType || null, size: a.size || 0 }));

/** Remember a new message (no-op unless this server logs messages). */
function record(message) {
  if (!shouldStore(message)) return false;
  const attachments = attachmentsOf(message);
  const content = String(message.content || (message.author.bot ? describe(message) : '')).slice(0, MAX_CONTENT);
  if (!content && !attachments.length) return false;
  run('INSERT OR REPLACE INTO message_store (id, guild_id, channel_id, author_id, author_tag, content, attachments, created_at, edited_at, author_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    [message.id, message.guild.id, message.channelId, message.author.id, message.author.tag, content, attachments.length ? JSON.stringify(attachments) : null, message.createdTimestamp || Date.now(), message.author.bot ? 1 : 0]);
  return true;
}

function get(id) {
  const row = selectOne('SELECT * FROM message_store WHERE id = ?', [String(id)]);
  if (!row) return null;
  let attachments = []; try { attachments = JSON.parse(row.attachments || '[]'); } catch { /* ignore */ }
  return { ...row, attachments };
}

/** Save an edit; returns the text it replaced (or null if the message wasn't stored). */
function updateContent(message, newContent) {
  const row = get(message.id);
  if (!row) { record(message); return null; }
  run('UPDATE message_store SET content = ?, edited_at = ? WHERE id = ?', [String(newContent || '').slice(0, MAX_CONTENT), Date.now(), String(message.id)]);
  return row.content;
}

function remove(id) { run('DELETE FROM message_store WHERE id = ?', [String(id)]); }
/** Forget stored bot messages (when the server switches bot logging off). */
function purgeBots(guildId) { run('DELETE FROM message_store WHERE guild_id = ? AND author_bot = 1', [String(guildId)]); }
function purgeGuild(guildId) { run('DELETE FROM message_store WHERE guild_id = ?', [String(guildId)]); }

/** Delete anything past retention, and trim to the row cap. */
function purgeOld() {
  run('DELETE FROM message_store WHERE created_at < ?', [Date.now() - RETENTION_MS]);
  const over = (selectOne('SELECT COUNT(*) AS n FROM message_store')?.n || 0) - MAX_ROWS;
  if (over > 0) run('DELETE FROM message_store WHERE id IN (SELECT id FROM message_store ORDER BY created_at ASC LIMIT ?)', [over]);
}

let timer = null;
function start() {
  if (timer) return;
  purgeOld();
  timer = setInterval(purgeOld, 3600_000);
  timer.unref?.();
}
function stop() { clearInterval(timer); timer = null; }

const count = (guildId) => selectOne('SELECT COUNT(*) AS n FROM message_store' + (guildId ? ' WHERE guild_id = ?' : ''), guildId ? [guildId] : [])?.n || 0;

module.exports = { botLoggingOn, wantsBot, describe, purgeBots, record, get, updateContent, remove, purgeGuild, purgeOld, start, stop, count, shouldStore, RETENTION_MS };
