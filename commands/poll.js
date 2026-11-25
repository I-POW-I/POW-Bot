const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');

const LENGTHS = [['1 hour', 1], ['4 hours', 4], ['8 hours', 8], ['24 hours', 24], ['3 days', 72], ['1 week', 168]];

module.exports = {
  data: (() => {
    const b = new SlashCommandBuilder().setName('poll').setDescription('Post a poll that members vote on with one click.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).setContexts(InteractionContextType.Guild)
      .addStringOption(o => o.setName('question').setDescription('What are you asking?').setRequired(true).setMaxLength(300))
      .addStringOption(o => o.setName('option1').setDescription('First choice').setRequired(true).setMaxLength(55))
      .addStringOption(o => o.setName('option2').setDescription('Second choice').setRequired(true).setMaxLength(55));
    for (let i = 3; i <= 6; i++) b.addStringOption(o => o.setName(`option${i}`).setDescription(`Choice ${i} (optional)`).setMaxLength(55));
    return b
      .addIntegerOption(o => o.setName('length').setDescription('How long the poll stays open (default 24 hours)').addChoices(...LENGTHS.map(([name, value]) => ({ name, value }))))
      .addBooleanOption(o => o.setName('multiple').setDescription('Let people pick more than one choice'));
  })(),

  async execute(interaction) {
    const answers = [];
    for (let i = 1; i <= 6; i++) { const t = interaction.options.getString(`option${i}`)?.trim(); if (t) answers.push({ text: t }); }
    if (new Set(answers.map(a => a.text.toLowerCase())).size !== answers.length) return interaction.reply({ content: '⚠️ Each choice has to be different.', flags: [MessageFlags.Ephemeral] });
    const me = interaction.guild.members.me;
    if (!interaction.channel?.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel])) {
      return interaction.reply({ content: '⚠️ I can\'t post in this channel. Give me **View Channel** and **Send Messages** here.', flags: [MessageFlags.Ephemeral] });
    }
    // Discord's own polls: votes are counted and shown live by Discord, and the poll closes by itself
    try {
      await interaction.reply({
        poll: { question: { text: interaction.options.getString('question').trim() }, answers, duration: interaction.options.getInteger('length') || 24, allowMultiselect: !!interaction.options.getBoolean('multiple') },
      });
    } catch (err) {
      return interaction.reply({ content: `⚠️ Discord would not post the poll: ${err.message}`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
  },
};
