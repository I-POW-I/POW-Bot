const { SlashCommandBuilder, MessageFlags, InteractionContextType } = require('discord.js');
const { changelogView } = require('../src/announcements');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('changelog')
    .setDescription('What has changed in the bot recently.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.reply({ ...changelogView(), flags: [MessageFlags.Ephemeral] });
  },
};
