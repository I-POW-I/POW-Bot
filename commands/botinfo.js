const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { buildStatsEmbed } = require('../src/statusUpdater');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('View Server info, Bot Uptime, & Stats.')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers), // Restricts command usage to staff only

  async execute(interaction, client) {
    try {
      // 1. Gather backend specifications directly from your existing tracker modules
      const statsEmbed = buildStatsEmbed(interaction.guildId, client);

      // 2. Transmit the information board privately so it doesn't clutter chat channels
      return interaction.reply({
        embeds: [statsEmbed],
        flags: [MessageFlags.Ephemeral]
      });
    } catch (error) {
      // 3. Prevent crashing if state cache modules are offline or uninitialized
      return interaction.reply({
        content: '❌ **Engine Error:** Unable to show bot info. Verify the bot is online & working.',
        flags: [MessageFlags.Ephemeral]
      });
    }
  },
};
