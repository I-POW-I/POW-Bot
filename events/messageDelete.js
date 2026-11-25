const { Events, EmbedBuilder, AuditLogEvent, AttachmentBuilder } = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');
const store             = require('../src/messageStore');
const { duration } = require('../src/duration');

const IMAGE_LIMIT = 8 * 1024 * 1024;
const isImage = (a) => (a?.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a?.name || a?.url || '');
/**
 * A deleted picture is often gone from Discord a moment later, so the log keeps its own copy: it is downloaded now,
 * while the link still works, and attached to the log entry. Returns null when it cannot be fetched.
 */
async function copyImage(a) {
  if (!a?.url || !isImage(a) || (a.size && a.size > IMAGE_LIMIT)) return null;
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(a.url, { signal: ctl.signal }); clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > IMAGE_LIMIT) return null;
    const name = String(a.name || 'image').replace(/[^\w.-]/g, '_').slice(-60) || 'image';
    return { buf, name: /\.(png|jpe?g|gif|webp)$/i.test(name) ? name : `${name}.png` };
  } catch { return null; }
}

// Discord merges several deletes by the same moderator in the same channel into one audit entry and counts them up,
// so an entry is recognised as new either by its age or by its count having gone up since it was last seen
const seenCounts = new Map();
async function getDeleter(guild, targetUserId, channelId, windowMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 });
    let found = null;
    for (const e of logs.entries.values()) {
      const count = Number(e.extra?.count || 1), before = seenCounts.get(e.id);
      seenCounts.set(e.id, count);
      if (found || e.target?.id !== targetUserId || e.extra?.channel?.id !== channelId) continue;
      if (Date.now() - e.createdTimestamp < windowMs || (before != null && count > before)) found = e;
    }
    if (seenCounts.size > 200) for (const k of [...seenCounts.keys()].slice(0, 100)) seenCounts.delete(k);
    if (!found || found.executor?.id === targetUserId) return null;
    return `${found.executor} — ${found.executor.tag}`;
  } catch { return null; }
}

function getMessageAge(createdAt) {
  if (!createdAt) return null;
  const ms = Date.now() - createdAt.getTime();
  return ms < 60_000 ? 'Just now' : `${duration(ms)} ago`;
}

module.exports = {
  name: Events.MessageDelete,
  once: false,

  async execute(message, client) {
    if (!message.guild) return;
    const guild = message.guild;

    // What we know: the live message if it was cached, otherwise the copy kept in the database
    const stored = store.get(message.id);
    // Other bots' messages are only logged when the server switched that on. This bot's own are logged only
    // inside the server's log channels, so that deleting a log entry is noticed
    const fromBot = !!(message.author?.bot || stored?.author_bot);
    const ownMessage = (message.author?.id || stored?.author_id) === message.client?.user?.id;
    if (fromBot && !(ownMessage ? store.isLogChannel(guild.id, message.channelId) : store.botLoggingOn(guild.id))) { if (stored) store.remove(message.id); return; }

    const channelId = getLogChannel(guild.id, 'messages');
    if (!channelId) return;
    const L = require('../src/logs');
    if (!L.enabled(guild.id, 'msgDelete') || L.isIgnored(guild.id, message.channelId)) { store.remove(message.id); return; }

    const authorId = message.author?.id || stored?.author_id;
    if (!ownMessage && L.authorIgnored(guild, authorId, message.member)) { store.remove(message.id); return; }
    const content  = message.content || (fromBot ? store.describe(message) : '') || stored?.content || null;
    const attachments = message.attachments?.size
      ? [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, type: a.contentType }))
      : (stored?.attachments || []);

    // Nothing is known about it (a bot's message, or sent before logging was switched on) — don't log noise
    if (!authorId && !content && !attachments.length) return;

    let logChannel;
    try {
      logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;
    } catch { return; }

    let author = message.author;
    if (!author && authorId) author = await (client || require('../src/client')).users.fetch(authorId).catch(() => null);
    const authorLabel = author ? `${message.member || author} — ${author.tag}` : `<@${authorId}>${stored?.author_tag ? ` — ${stored.author_tag}` : ''}`;
    const sentAt      = message.createdAt || (stored ? new Date(stored.created_at) : null);
    const deletedBy   = authorId ? await getDeleter(guild, authorId, message.channelId) : null;

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(ownMessage ? '🗑️ POW-Bot log deleted' : fromBot ? '🗑️ Bot message deleted' : '🗑️ Message deleted');

    if (author) {
      embed
        .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(author.displayAvatarURL({ dynamic: true, size: 256 }));
    }

    embed.addFields(
      { name: 'Author',  value: authorLabel,                                                                  inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`,                  inline: true },
      { name: 'Sent',    value: getMessageAge(sentAt) || '—',                                                 inline: true },
    );

    if (deletedBy) embed.addFields({ name: 'Deleted by', value: deletedBy, inline: false });

    embed.addFields({
      name:   'Content',
      value:  content
        ? (content.length > 1024 ? content.slice(0, 1021) + '...' : content)
        : (attachments.length ? '*No text — attachment only*' : '*Text wasn\'t recorded*'),
      inline: false,
    });

    // the log entry is one message; a deleted picture follows as its own message holding only the picture
    let picture = null;
    if (attachments.length > 0) {
      const list = attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      embed.addFields({ name: `Attachments (${attachments.length})`, value: list.slice(0, 1024), inline: false });
      const firstImage = attachments.find(isImage);
      if (firstImage) {
        const copy = await copyImage(firstImage);
        const shot = new EmbedBuilder().setColor(0xED4245);
        if (copy) { picture = { embeds: [shot.setImage(`attachment://${copy.name}`)], files: [new AttachmentBuilder(copy.buf, { name: copy.name })], plainEmbeds: true }; }
        else picture = { embeds: [shot.setImage(firstImage.url)], plainEmbeds: true };
      }
    }

    try {
      await logChannel.send({ embeds: [embed] });
      if (picture) await logChannel.send(picture);
    } catch (err) {
      log('WARN', 'Failed to send message delete log', { err });
    }
    store.remove(message.id);   // logged — no reason to keep the text any longer
  },
};
