const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const lock = require('./lock');

module.exports = {
  data: new SlashCommandBuilder().setName('unlock').setDescription('Let members send messages in a channel again.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).setContexts(InteractionContextType.Guild)
    .addChannelOption(lock._channelOption),
  execute: (interaction) => lock._setLocked(interaction, false),
};
