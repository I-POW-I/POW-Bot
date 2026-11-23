const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType } = require('discord.js');
const { buildBotInfoEmbed, buildOwnerEmbeds } = require('../src/botInfo');
const { isBotAdmin } = require('../src/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Full bot status and statistics (server admins and bot owners).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, client) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !isBotAdmin(interaction.user.id)) {
      return interaction.reply({ content: 'You need the **Manage Server** permission to use this. Press **Bot Info** on the panel for a short summary.', flags: [MessageFlags.Ephemeral] });
    }
    try {
      // Time between Discord creating the interaction and the bot receiving it (this replaces /ping)
      const responseMs = Math.max(0, Date.now() - interaction.createdTimestamp);
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const embeds = [buildBotInfoEmbed(interaction.guildId, client, { responseMs, detailed: true })];

      // The bot owner and selected bot admins also get system, usage and safety details
      if (isBotAdmin(interaction.user.id)) embeds.push(...await buildOwnerEmbeds(client));

      return interaction.editReply({ embeds });
    } catch (error) {
      // Prevent crashing if state cache modules are offline or uninitialized
      const payload = { content: '**Engine Error:** Unable to show bot info. Verify the bot is online & working.', flags: [MessageFlags.Ephemeral] };
      return interaction.deferred ? interaction.editReply({ content: payload.content }) : interaction.reply(payload);
    }
  },
};
