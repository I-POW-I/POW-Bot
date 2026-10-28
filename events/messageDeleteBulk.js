const { Events, EmbedBuilder } = require('discord.js');
const { getLogChannel } = require('../src/guildConfig');

module.exports = {
  name: Events.MessageBulkDelete,
  async execute(messages) {
    const firstMessage = messages.first();
    if (!firstMessage || !firstMessage.guild) return;

    // Fetch the dedicated messages logging channel ID from your system
    const logChannelId = getLogChannel(firstMessage.guild.id, 'messages');
    if (!logChannelId) return;

    const logChannel = firstMessage.guild.channels.cache.get(logChannelId);
    if (!logChannel) return;

    // Build a chronological log transcript string of the wiped messages
    let logTranscript = '';
    messages.reverse().forEach(msg => {
      const authorTag = msg.author ? `${msg.author.tag} (${msg.author.id})` : 'Unknown User';
      const contentStr = msg.content ? msg.content : '*[No Text Content / Attachment]*';
      logTranscript += `[${authorTag}]: ${contentStr}\n`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🚨 Mass Messages Bulk Purged')
      .setColor(0xED4245)
      .setDescription(`**${messages.size}** messages were completely wiped simultaneously inside <#${firstMessage.channel.id}>.`)
      .setTimestamp();

    // Check if the formatting fits within Discord's max embed boundaries safely
    if (logTranscript.length <= 1000) {
      embed.addFields({ name: 'Wiped Messages Transcript', value: `\`\`\`text\n${logTranscript}\`\`\`` });
      return logChannel.send({ embeds: [embed] }).catch(() => null);
    } else {
      embed.addFields({ name: 'Wiped Messages Transcript', value: `\`\`\`text\n${logTranscript.substring(0, 950)}\n...and more files truncated\`\`\`` });
      return logChannel.send({ embeds: [embed] }).catch(() => null);
    }
  }
};
