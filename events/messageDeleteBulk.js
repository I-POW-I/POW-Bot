const { Events, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getLogChannel } = require('../src/guildConfig');
const { log }           = require('../src/logger');
const store             = require('../src/messageStore');

module.exports = {
  name: Events.MessageBulkDelete,
  async execute(messages) {
    const firstMessage = messages.first();
    const guild = firstMessage?.guild;
    if (!guild) return;

    const logChannelId = getLogChannel(guild.id, 'messages');
    if (!logChannelId) return;
    const logChannel = guild.channels.cache.get(logChannelId);
    if (!logChannel) return;

    // Full transcript, oldest first. Messages missing from the cache come from the database.
    let known = 0;
    const lines = [...messages.values()].reverse().map(msg => {
      const stored = store.get(msg.id);
      const authorTag = msg.author ? `${msg.author.tag} (${msg.author.id})` : stored ? `${stored.author_tag || 'Unknown'} (${stored.author_id})` : 'Unknown user';
      const text = msg.content || stored?.content || '';
      const files = msg.attachments?.size ? [...msg.attachments.values()].map(a => a.url) : (stored?.attachments || []).map(a => a.url);
      if (text || files.length) known++;
      return `[${authorTag}]: ${text || '(no text)'}${files.length ? ` ${files.join(' ')}` : ''}`;
    });
    for (const msg of messages.values()) store.remove(msg.id);

    const transcript = lines.join('\n');
    const embed = new EmbedBuilder()
      .setTitle('Messages bulk deleted')
      .setColor(0xED4245)
      .setDescription(`**${messages.size}** messages were deleted at once in <#${firstMessage.channelId}>.${known < messages.size ? `\n*${messages.size - known} of them weren't recorded.*` : ''}`)
      .setTimestamp();

    const payload = { embeds: [embed] };
    if (transcript.length <= 900) embed.addFields({ name: 'Transcript', value: `\`\`\`text\n${transcript || '(nothing recorded)'}\n\`\`\`` });
    else payload.files = [new AttachmentBuilder(Buffer.from(transcript), { name: 'deleted-messages.txt' })];   // full transcript, nothing cut off

    try { await logChannel.send(payload); }
    catch (err) { log('WARN', 'Failed to send bulk delete log', { err }); }
  },
};
