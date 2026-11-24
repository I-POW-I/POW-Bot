const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a timeout from a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setContexts(InteractionContextType.Guild)
    .addUserOption(o => o.setName('member').setDescription('Whose timeout to remove').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(400)),
  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const r = await mod.perform(interaction, { action: 'untimeout', user: interaction.options.getUser('member'), reason: interaction.options.getString('reason') });
    return interaction.editReply({ content: r.ok ? `✅ ${r.text}` : `⚠️ ${r.text}` });
  },
};
