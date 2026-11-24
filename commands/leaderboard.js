const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const leaderboard = require('../src/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Who has spent the most time in voice channels in this server.')
    .addStringOption(o => o.setName('period').setDescription('How far back to look (default: all time)')
      .addChoices(...Object.entries(leaderboard.PERIODS).map(([value, p]) => ({ name: p.label, value }))))
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    // A public post everyone can read, so it has no personal "your position" line and no menu that would change it for others
    await interaction.deferReply();
    const { embeds } = await leaderboard.view(interaction.guild, interaction.options.getString('period') || 'all', null);
    await interaction.editReply({ embeds });
  },
};
