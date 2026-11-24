const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('timeout').setDescription('Mute a member for a while (up to 28 days).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setContexts(InteractionContextType.Guild)
    .addUserOption(o => o.setName('member').setDescription('Who to time out').setRequired(true))
    .addStringOption(o => o.setName('length').setDescription('How long, like 10m, 2h, 1d or 1d12h').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(400)),
  async execute(interaction) {
    const ms = mod.parseDuration(interaction.options.getString('length'));
    if (!ms) return interaction.reply({ content: '⚠️ I couldn\'t read that length. Try `10m`, `2h`, `1d` or `1d12h`.', flags: [MessageFlags.Ephemeral] });
    if (ms < 60_000 || ms > mod.MAX_TIMEOUT) return interaction.reply({ content: '⚠️ A timeout can be from 1 minute to 28 days.', flags: [MessageFlags.Ephemeral] });
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const r = await mod.perform(interaction, { action: 'timeout', user: interaction.options.getUser('member'), reason: interaction.options.getString('reason'), durationMs: ms });
    return interaction.editReply({ content: r.ok ? `✅ ${r.text}` : `⚠️ ${r.text}` });
  },
};
