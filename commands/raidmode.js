const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const raid = require('../src/raid');
const { duration } = require('../src/duration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raidmode')
    .setDescription('Turn raid mode on or off, or see its state')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(s => s.setName('on').setDescription('Start raid mode now'))
    .addSubcommand(s => s.setName('off').setDescription('End raid mode'))
    .addSubcommand(s => s.setName('status').setDescription('Show what raid protection is doing')),

  async execute(interaction) {
    const { guild, user } = interaction;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    let s = raid.settings(guild.id);

    if (sub === 'on') {
      if (raid.isActive(s)) return interaction.editReply({ content: '⚠️ Raid mode is already on.' });
      const r = await raid.start(guild, user, `Started by ${user.tag || user.username}`);
      s = r.s || raid.settings(guild.id);
      return interaction.editReply({ content: `🔴 **Raid mode is on.** ${raid.describeMode(s)}.${s.modeMinutes ? ` It ends in ${duration(s.modeMinutes * 60_000)}.` : ' It stays on until you run `/raidmode off`.'}${r.note ? `\n⚠️ ${r.note}` : ''}` });
    }
    if (sub === 'off') {
      if (!s.active) return interaction.editReply({ content: '⚠️ Raid mode is not on.' });
      await raid.stop(guild, user, `Ended by ${user.tag || user.username}`);
      return interaction.editReply({ content: '✅ **Raid mode is off.**' });
    }
    const active = raid.isActive(s);
    const embed = new EmbedBuilder().setColor(active ? 0xED4245 : 0x57F287).setTitle('Raid protection')
      .setDescription([active ? `🔴 **Raid mode is ON**${s.until ? `, ends <t:${Math.floor(s.until / 1000)}:R>` : ''}\n${raid.describeMode(s)}` : '⚪ Raid mode is off',
        `Detection: ${s.enabled ? `on, ${s.joins} joins in ${s.seconds} seconds` : 'off'}`, `Account age gate: ${s.gateEnabled ? `on, under ${s.gateDays} day${s.gateDays === 1 ? '' : 's'}` : 'off'}`,
        `Members actioned so far: ${s.caught}`, '', 'Change the settings in `/setup` > Raid protection.'].join('\n'));
    return interaction.editReply({ embeds: [embed] });
  },
};
