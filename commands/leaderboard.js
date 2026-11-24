const { SlashCommandBuilder, MessageFlags, InteractionContextType } = require('discord.js');
const leaderboard = require('../src/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Who has spent the most time in voice channels in this server.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    await interaction.editReply(await leaderboard.view(interaction.guild, 'all', interaction.user.id));
  },
};
