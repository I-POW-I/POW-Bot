const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, InteractionContextType } = require('discord.js');
const retention = require('../src/retention');
const { linkRows } = require('../src/links');
const { log } = require('../src/logger');

const BLUE = 0x5865F2, RED = 0xED4245;
const n = (v) => v.toLocaleString('en-GB');

function viewHome(userId) {
  const d = retention.userData(userId), empty = !(d.voice || d.streams || d.events || d.messages);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('🔒 Your data').setDescription([
    'This is everything the bot has stored about you across all servers it shares with you.',
    '',
    `**Voice sessions:** ${n(d.voice)}`,
    '*When you joined and left voice channels. Sessions older than a year are merged into a single total.*',
    `**Live sessions:** ${n(d.streams)}`,
    '*When you went live in a voice channel. Kept for 1 year.*',
    `**Join and leave history:** ${n(d.events)}`,
    '*Kept for 90 days.*',
    `**Recent messages:** ${n(d.messages)}`,
    `*Only held for servers that use the deleted and edited message logs. Kept for ${retention.messageDays} days.*`,
  ].join('\n'));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('privacy:ask').setLabel('Delete my data').setStyle(ButtonStyle.Danger).setDisabled(empty));
  return { embeds: [embed], components: [buttons, ...linkRows()] };
}

const viewConfirm = () => ({
  embeds: [new EmbedBuilder().setColor(RED).setTitle('Delete your data?').setDescription('This permanently removes everything listed on the previous screen, in every server. Your voice time on leaderboards starts again from zero, and any voice reward roles you hold are re-checked. This cannot be undone.')],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('privacy:confirm').setLabel('Delete everything').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('privacy:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('See what the bot has stored about you, or delete it')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),

  async execute(interaction) {
    return interaction.reply({ ...viewHome(interaction.user.id), flags: [MessageFlags.Ephemeral] });
  },

  /** Buttons on the /privacy screen. Returns true when handled. */
  async handleComponent(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('privacy:')) return false;
    const action = interaction.customId.split(':')[1];
    if (action === 'ask') { await interaction.update(viewConfirm()); return true; }
    if (action === 'cancel') { await interaction.update(viewHome(interaction.user.id)); return true; }
    if (action === 'confirm') {
      retention.forgetUser(interaction.user.id);
      log('INFO', 'A member deleted their stored data', { user: interaction.user.id });
      await interaction.update({ ...viewHome(interaction.user.id), content: 'Your data has been deleted.' });
      return true;
    }
    return false;
  },
};
