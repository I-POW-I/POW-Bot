const { SlashCommandBuilder, MessageFlags, InteractionContextType } = require('discord.js');
const { buildBotInfoEmbed, buildOwnerEmbeds } = require('../src/botInfo');
const { isBotAdmin } = require('../src/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Show the bot\'s status, latency and resource usage')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, client) {
    // Time between Discord creating the interaction and the bot receiving it (this replaces /ping)
    const responseMs = Math.max(0, Date.now() - interaction.createdTimestamp);
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const embeds = [buildBotInfoEmbed(interaction.guildId, client, { responseMs })];

    // The bot owner and selected bot admins also get system, usage and safety details
    if (isBotAdmin(interaction.user.id)) embeds.push(...await buildOwnerEmbeds(client));

    return interaction.editReply({ embeds });
  },
};
