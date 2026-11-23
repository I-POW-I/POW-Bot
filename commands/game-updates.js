/**
 * /game-updates: the games this server gets patch-note alerts for.
 * Sources: Steam, Minecraft (Java + Bedrock), Riot Games, Fortnite, Blizzard, any RSS/Atom feed.
 * Staff get a button that opens the setup page (/setup -> Game update alerts), where alerts are added, changed and removed.
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  PermissionFlagsBits, InteractionContextType,
} = require('discord.js');
const { subsOf } = require('../src/setupAlerts');
const { SOURCES, parseKey } = require('../src/updates/sources');

const data = new SlashCommandBuilder()
  .setName('game-updates')
  .setDescription('Games this server gets patch note alerts for')
  .setContexts(InteractionContextType.Guild);

async function execute(interaction) {
  const subs = subsOf(interaction.guildId);
  const staff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const components = staff ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:updates').setLabel('Manage game alerts').setStyle(ButtonStyle.Primary))] : [];

  if (!subs.length) {
    return interaction.reply({ content: staff ? 'No game update alerts yet.' : 'This server has no game update alerts.', components, flags: [MessageFlags.Ephemeral] });
  }
  const lines = subs.map(s => `**${s.game_name || s.app_id}** · ${SOURCES[parseKey(s.app_id).source]?.label || 'Steam'}\n└ <#${s.channel_id}>${s.role_id ? ` · <@&${s.role_id}>` : ''}`);
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`Game update alerts (${subs.length})`).setDescription(lines.join('\n').slice(0, 3900))],
    components, flags: [MessageFlags.Ephemeral],
  });
}

module.exports = { data, execute };
