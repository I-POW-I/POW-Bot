const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('case').setDescription('Look up a moderation case, or change its reason.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setContexts(InteractionContextType.Guild)
    .addIntegerOption(o => o.setName('number').setDescription('The case number').setMinValue(1).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('A new reason for this case (leave empty to just view it)').setMaxLength(400)),

  async execute(interaction) {
    const number = interaction.options.getInteger('number');
    const c = mod.getCase(interaction.guildId, number);
    if (!c) return interaction.reply({ content: `⚠️ There is no case #${number} in this server.`, flags: [MessageFlags.Ephemeral] });

    const reason = interaction.options.getString('reason');
    const updated = reason ? mod.setReason(interaction.guildId, number, reason.trim()) : c;
    const user = await interaction.client.users.fetch(c.user_id).catch(() => null);
    const embeds = [mod.caseEmbed(updated, { user })];
    if (reason) embeds.push(new EmbedBuilder().setColor(0x57F287).setDescription('✅ Reason updated.'));
    return interaction.reply({ embeds, flags: [MessageFlags.Ephemeral] });
  },
};
