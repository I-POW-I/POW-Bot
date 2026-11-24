/**
 * /streamers: who the server watches for go-live alerts, and who is live right now.
 * Staff get a button that opens the setup page (/setup -> Streamer alerts), where streamers are added and removed.
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  PermissionFlagsBits, InteractionContextType,
} = require('discord.js');
const { selectAll } = require('../src/database');

const NAMES = { kick: 'Kick', twitch: 'Twitch', youtube: 'YouTube' };

/** Two lines per streamer with a gap between them, cut at a whole entry if the list is long. */
function listValue(list) {
  const entries = list.map(s => `${s.is_live === 1 ? '🟢' : '⚫'} **${s.display_name || s.username}**${s.is_live === 1 ? ' · live now' : ''}\nAlerts in <#${s.discord_channel_id}>${s.role_id ? ` · pings <@&${s.role_id}>` : ''}`);
  let out = '';
  for (const [i, e] of entries.entries()) {
    const next = out ? `${out}\n\n${e}` : e;
    if (next.length > 960) return `${out}\n\n…and ${entries.length - i} more`;
    out = next;
  }
  return out;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('streamers')
    .setDescription('Streamers this server watches, and who is live now')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const { guild } = interaction;
    const subs = selectAll('SELECT * FROM streamer_subscriptions WHERE guild_id = ? ORDER BY platform, display_name, username', [guild.id]);
    const staff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    const components = staff ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:streamers').setLabel('Manage streamers').setStyle(ButtonStyle.Primary))] : [];

    if (!subs.length) {
      return interaction.reply({ content: staff ? 'No streamers are being watched yet.' : 'No streamers are being watched in this server.', components, flags: [MessageFlags.Ephemeral] });
    }

    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Watched streamers')
      .setFooter({ text: `${subs.length} streamer(s) · ${subs.filter(s => s.is_live === 1).length} live now` });
    for (const platform of Object.keys(NAMES)) {
      const list = subs.filter(s => s.platform === platform);
      if (!list.length) continue;
      embed.addFields({
        name: NAMES[platform],
        value: listValue(list),
      });
    }
    await interaction.reply({ embeds: [embed] });
    // The manage button is only for staff, so it is sent privately
    if (staff) await interaction.followUp({ content: 'Add or remove streamers:', components, flags: [MessageFlags.Ephemeral] });
  },
};
