const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member, or anyone by their ID, and record it as a case.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setContexts(InteractionContextType.Guild)
    .addUserOption(o => o.setName('user').setDescription('Who to ban (a mention or a user ID)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(400))
    .addStringOption(o => o.setName('delete_messages').setDescription('Delete their messages from the last… (default: none)')
      .addChoices({ name: 'Don\'t delete any', value: 'none' }, { name: 'Last hour', value: '1h' }, { name: 'Last day', value: '1d' }, { name: 'Last 7 days', value: '7d' })),
  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const r = await mod.perform(interaction, { action: 'ban', user: interaction.options.getUser('user'), reason: interaction.options.getString('reason'),
      deleteSeconds: mod.DELETE_CHOICES[interaction.options.getString('delete_messages') || 'none'] });
    return interaction.editReply({ content: r.ok ? `✅ ${r.text}` : `⚠️ ${r.text}` });
  },
};
