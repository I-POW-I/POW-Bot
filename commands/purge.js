const {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder,
} = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete a set number of messages from this channel (max 100)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(opt =>
      opt
        .setName('amount')
        .setDescription('Number of messages to delete (1–100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    ),

  async execute(interaction) {
    const { guild, channel, member } = interaction;
    const amount = interaction.options.getInteger('amount');

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const fetched  = await channel.messages.fetch({ limit: amount });
      const cutoff   = Date.now() - 14 * 24 * 60 * 60 * 1000;

      const recent = fetched.filter(m => m.createdTimestamp > cutoff);
      const old    = fetched.filter(m => m.createdTimestamp <= cutoff);

      let bulkDeleted = 0;
      let oldDeleted  = 0;

      // ── Bulk delete recent messages ─────────────────────────────────────────
      if (recent.size > 0) {
        const deleted = await channel.bulkDelete(recent, true);
        bulkDeleted = deleted.size;
      }

      // ── Reply immediately so the user knows what's happening ───────────────
      let replyContent = `Deleted **${bulkDeleted}** recent message(s).`;
      if (old.size > 0) {
        replyContent += `\n⏳ **${old.size}** message(s) are older than 14 days — deleting individually in the background...`;
      }
      await interaction.editReply({ content: replyContent });

      // ── Delete old messages one by one in the background ───────────────────
      if (old.size > 0) {
        for (const [, message] of old) {
          try {
            await message.delete();
            oldDeleted++;
          } catch {
            // Message may have already been deleted — skip silently
          }
          // Respect Discord rate limits — 1 delete per 200ms
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        // Update the reply once old deletions are done
        await interaction.editReply({
          content: `Done — deleted **${bulkDeleted + oldDeleted}** message(s) total.\n*(${bulkDeleted} bulk · ${oldDeleted} individual)*`,
        });
      }

      const totalDeleted = bulkDeleted + oldDeleted;

      log('INFO', 'Purge executed', {
        guild:   guild.name,
        channel: channel.name,
        bulk:    bulkDeleted,
        old:     oldDeleted,
        total:   totalDeleted,
        by:      member.user.tag,
      });

      // ── Purge log ───────────────────────────────────────────────────────────
      const logChannelId = getLogChannel(guild.id, 'messages');
      if (logChannelId) {
        try {
          const logChannel = await guild.channels.fetch(logChannelId);
          if (logChannel?.isTextBased()) {
            const fields = [
              { name: 'Purged By', value: `${member} — ${member.user.tag}`, inline: true },
              { name: 'Channel',   value: `<#${channel.id}>`,               inline: true },
              { name: 'Total',     value: `${totalDeleted}`,                 inline: true },
            ];

            if (old.size > 0) {
              fields.push(
                { name: 'Bulk Deleted',       value: `${bulkDeleted}`, inline: true },
                { name: 'Individual Deleted', value: `${oldDeleted}`,  inline: true },
                { name: '\u200b',             value: '\u200b',          inline: true },
              );
            }

            await logChannel.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0xFF7043)
                  .setTitle('Channel Purged')
                  .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
                  .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
                  .addFields(fields)
                  .setTimestamp()
                  
              ],
            });
          }
        } catch (err) {
          log('WARN', 'Could not send purge log', { err });
        }
      }

    } catch (err) {
      log('ERROR', 'Purge failed', { guild: guild.name, err });
      return interaction.editReply({
        content: '❌ Failed — make sure I have the **Manage Messages** permission.',
      });
    }
  },
};
