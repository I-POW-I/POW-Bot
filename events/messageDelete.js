const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');
const store             = require('../src/messageStore');
const { duration } = require('../src/duration');

async function getDeleter(guild, targetUserId, channelId, windowMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 });
    const entry = logs.entries.find(e =>
      e.target?.id === targetUserId &&
      e.extra?.channel?.id === channelId &&
      (Date.now() - e.createdTimestamp) < windowMs
    );
    if (!entry || entry.executor?.id === targetUserId) return null;
    return `${entry.executor} — ${entry.executor.tag}`;
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
    const channelName = guild.channels.cache.get(message.channelId)?.name;
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
      { name: 'Channel', value: `<#${message.channelId}>${channelName ? ` (#${channelName})` : ''}`,          inline: true },
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

    if (attachments.length > 0) {
      const list = attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      embed.addFields({ name: `Attachments (${attachments.length})`, value: list.slice(0, 1024), inline: false });
      const firstImage = attachments.find(a => a.type?.startsWith('image/'));
      if (firstImage) embed.setImage(firstImage.url);
    }

    try {
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send message delete log', { err });
    }
    store.remove(message.id);   // logged — no reason to keep the text any longer
  },
};
