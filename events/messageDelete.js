const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');

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
  const ms      = Date.now() - createdAt.getTime();
  const minutes = Math.floor(ms / 60000);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  if (days > 0)    return `${days}d ${hours % 24}h ago`;
  if (hours > 0)   return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

module.exports = {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    // ── 1. Safe Partials Recovery Interception ──
    if (message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        // If Discord completely wiped the text from its routers, execute an intent-safe fallback summary
        return handleColdTraceLog(message);
      }
    }

    // Now it is safe to check for bot statuses or server configurations
    if (!message.guild || message.author?.bot) return;

    const guild = message.guild;
    const channelId = getLogChannel(guild.id, 'messages');
    if (!channelId) return;

    let logChannel;
    try {
      logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;
    } catch { return; }

    const author      = message.author;
    const content     = message.content || null;
    const attachments = [...(message.attachments?.values() || [])];
    const messageAge  = getMessageAge(message.createdAt);
    const deletedBy   = author ? await getDeleter(guild, author.id, message.channelId) : null;

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('Message Deleted')
      .setTimestamp();

    if (author) {
      embed
        .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(author.displayAvatarURL({ dynamic: true, size: 256 }));
    }

    embed.addFields(
      { name: 'Author',  value: author ? `${message.member || author} — ${author.tag}` : 'Unknown', inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`,                                           inline: true },
      { name: 'Sent',    value: messageAge || '—',                                                   inline: true },
    );

    if (deletedBy) {
      embed.addFields({ name: 'Deleted By', value: deletedBy, inline: false });
    }

    if (content) {
      embed.addFields({
        name:   'Content',
        value:  content.length > 1024 ? content.slice(0, 1021) + '...' : content,
        inline: false,
      });
    } else {
      embed.addFields({
        name:   'Content',
        value:  '*[Message contained zero textual strings — purely embed structure or system update]*',
        inline: false,
      });
    }

    if (attachments.length > 0) {
      const list = attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      embed.addFields({ name: `Attachments (${attachments.length})`, value: list, inline: false });
      const firstImage = attachments.find(a => a.contentType?.startsWith('image/'));
      if (firstImage) embed.setImage(firstImage.url);
    }

    try {
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send message delete log', { error: err.message });
    }
  },
};

// ── 2. Fallback Logger for Expired Messages ──
async function handleColdTraceLog(partialMessage) {
  if (!partialMessage.guild) return;
  
  const channelId = getLogChannel(partialMessage.guild.id, 'messages');
  if (!channelId) return;

  try {
    const logChannel = await partialMessage.guild.channels.fetch(channelId);
    if (!logChannel?.isTextBased()) return;

    const fallbackEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('Message Deleted (Cold Cache Tracker)')
      .setDescription('🗑️ *An older message was deleted. Its original text content was evicted from memory caches before the event fired.*')
      .addFields(
        { name: 'Channel Location', value: `<#${partialMessage.channelId}>`, inline: true },
        { name: 'Message Reference ID', value: `\`${partialMessage.id}\``, inline: true }
      )
      .setTimestamp();

    await logChannel.send({ embeds: [fallbackEmbed] });
  } catch (err) {
    log('WARN', 'Failed to process cold message delete fallback log', { error: err.message });
  }
}
