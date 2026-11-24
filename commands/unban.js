const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('unban').setDescription('Unban someone and record it as a case.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setContexts(InteractionContextType.Guild)
    .addStringOption(o => o.setName('user').setDescription('Start typing a name or paste a user ID').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(400)),

  // Suggests people who are banned in this server
  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const bans = await interaction.guild.bans.fetch({ limit: 1000 }).catch(() => null);
    const list = bans ? [...bans.values()].filter(b => b.user.id.includes(typed) || mod.tagOf(b.user).toLowerCase().includes(typed)).slice(0, 25) : [];
    return interaction.respond(list.map(b => ({ name: `${mod.tagOf(b.user)} (${b.user.id})`.slice(0, 100), value: b.user.id })));
  },

  async execute(interaction) {
    const id = interaction.options.getString('user').trim().replace(/[<@!>]/g, '');
    if (!/^\d{15,25}$/.test(id)) return interaction.reply({ content: '⚠️ Pick someone from the list, or paste their user ID.', flags: [MessageFlags.Ephemeral] });
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const user = await interaction.client.users.fetch(id).catch(() => null);
    if (!user) return interaction.editReply({ content: '⚠️ I couldn\'t find that user.' });
    const r = await mod.perform(interaction, { action: 'unban', user, reason: interaction.options.getString('reason') });
    return interaction.editReply({ content: r.ok ? `✅ ${r.text}` : `⚠️ ${r.text}` });
  },
};
