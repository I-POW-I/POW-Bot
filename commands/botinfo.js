const { SlashCommandBuilder, MessageFlags, InteractionContextType } = require('discord.js');
const { buildBotInfoEmbed, buildOwnerEmbeds } = require('../src/botInfo');
const { isBotAdmin } = require('../src/permissions');
const { linkRows } = require('../src/links');
const { log } = require('../src/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Status, memory use and version of the bot.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, client) {
    try {
      await interaction.deferReply();
      await interaction.editReply({ embeds: [buildBotInfoEmbed(interaction.guildId, client)], components: linkRows() });
    } catch (err) {
      log('WARN', '/botinfo failed', { err });
      const content = 'I could not load the bot info. Try again in a moment.';
      return interaction.deferred || interaction.replied ? interaction.editReply({ content, embeds: [], components: [] }).catch(() => {}) : interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

    // The full system, usage and safety details are for the bot owner and admins only, and only they can see them
    if (isBotAdmin(interaction.user.id)) {
      try {
        await interaction.followUp({ embeds: await buildOwnerEmbeds(client), flags: [MessageFlags.Ephemeral] });
      } catch (err) {
        log('WARN', '/botinfo owner details failed', { err });
        await interaction.followUp({ content: 'I could not load the owner details. Open **/owner** instead.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
    }
  },
};
