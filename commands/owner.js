/**
 * /owner: the bot owner's control panel. Works in any server the bot is in (and in its DMs), but only for
 * the people listed in the Discloud variables OWNER_IDS and ADMIN_IDS. Everything lives in src/ownerHub.js.
 */

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const hub = require('../src/ownerHub');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription('Bot owner control panel')
    .setDefaultMemberPermissions(0)                       // hidden from regular members; the code still checks your ID
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),

  execute: (interaction, client) => hub.open(interaction, client || interaction.client),
  handleComponent: hub.handleComponent,
  _pending: hub._pending,
};
