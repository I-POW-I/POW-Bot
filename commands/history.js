const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');

const SHOWN = 10;

module.exports = {
  data: new SlashCommandBuilder().setName('history').setDescription('Everything moderation has done to a member in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setContexts(InteractionContextType.Guild)
    .addUserOption(o => o.setName('user').setDescription('A member, or anyone by their user ID').setRequired(true)),

  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const all = mod.history(interaction.guildId, user.id, 200);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`History · ${user.tag || user.username}`).setThumbnail(user.displayAvatarURL());

    if (!all.length) {
      embed.setDescription(`${user} has a clean record in this server.`);
      return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    const counts = mod.counts(interaction.guildId, user.id);
    const summary = Object.entries(counts).map(([a, n]) => `${n} ${(mod.ACTIONS[a]?.label || a).toLowerCase()}${n === 1 ? '' : 's'}`).join(' · ');
    embed.setDescription([`${user} · ID \`${user.id}\``, `**${all.length}** case${all.length === 1 ? '' : 's'}: ${summary}`, '',
      all.slice(0, SHOWN).map(mod.caseLine).join('\n\n')].join('\n').slice(0, 4000));
    if (all.length > SHOWN) embed.setFooter({ text: `Showing the latest ${SHOWN} of ${all.length}. Use /case <number> for the rest.` });
    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  },
};
