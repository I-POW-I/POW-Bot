const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType } = require('discord.js');
const { viewHome } = require('../src/setup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set up the bot — panel, logs, welcome, verification and alerts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    // Everything happens on this one interactive screen (src/setup.js handles its buttons and menus)
    return interaction.reply({ ...viewHome(interaction.guild), flags: [MessageFlags.Ephemeral] });
  },
};
