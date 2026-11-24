const { Events, EmbedBuilder } = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');
const store             = require('../src/messageStore');

module.exports = {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    if (!newMessage.guild) return;

    // Edited messages may be partial after a restart — load the full message
    if (newMessage.partial) { try { newMessage = await newMessage.fetch(); } catch { return; } }
    if (newMessage.author?.bot) return;

    const guild     = newMessage.guild;
    const channelId = getLogChannel(guild.id, 'messages');
    if (!channelId) return;

    // "Before" = the cached old message, or else the copy kept in the database
    const stored     = store.get(newMessage.id);
    const before     = oldMessage.partial ? (stored?.content ?? null) : (oldMessage.content ?? stored?.content ?? null);
    const newContent = newMessage.content || '';
    if (before !== null && before === newContent) { return; }             // link previews etc. — not a real edit
    // Unknown "before": only log if Discord says this really was an edit a moment ago (not a link preview)
    if (before === null && !(newMessage.editedTimestamp && Date.now() - newMessage.editedTimestamp < 15_000)) { store.updateContent(newMessage, newContent); return; }

    store.updateContent(newMessage, newContent);

    let logChannel;
    try {
      logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;
    } catch { return; }

    const author     = newMessage.author;
    const oldContent = before || '*Wasn\'t recorded (sent before logging was switched on)*';

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('✏️ Message edited')
      .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL({ dynamic: true }) })
      .setThumbnail(author.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: 'Author',  value: `${newMessage.member || author} — ${author.tag}`, inline: true },
        { name: 'Channel', value: `<#${newMessage.channelId}>`,                      inline: true },
        { name: 'Jump',    value: `[View Message](${newMessage.url})`,               inline: true },
        {
          name:   'Before',
          value:  oldContent.length > 1024 ? oldContent.slice(0, 1021) + '...' : oldContent,
          inline: false,
        },
        {
          name:   'After',
          value:  (newContent || '*Empty*').length > 1024 ? newContent.slice(0, 1021) + '...' : (newContent || '*Empty*'),
          inline: false,
        },
      );

    try {
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send message edit log', { err });
    }
  },
};
