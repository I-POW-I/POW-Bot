/**
 * Small building blocks shared by the /setup screens (setup.js and setupAlerts.js).
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const BLUE = 0x5865F2, GREEN = 0x57F287, AMBER = 0xFAA61A, RED = 0xED4245;
const ephemeral = [MessageFlags.Ephemeral];

const chan = (id) => id ? `<#${id}>` : '*not set*';
const role = (id) => id ? `<@&${id}>` : '*not set*';
const onOff = (v) => v ? 'on' : 'off';

const noteBad  = (text) => `⚠️ **Problem:** ${text}`;
const noteGood = (text) => `✅ ${text}`;

const backButton = (page = 'home', label = 'Back') =>
  new ButtonBuilder().setCustomId(`setup:${page}`).setLabel(label).setStyle(ButtonStyle.Secondary);

const channelSelect = (id, placeholder, current, types = [ChannelType.GuildText]) => {
  const m = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(...types).setMinValues(1).setMaxValues(1);
  if (current) m.setDefaultChannels(current);
  return new ActionRowBuilder().addComponents(m);
};

/** `optional` lets the person clear the choice by deselecting. */
const roleSelect = (id, placeholder, current, optional = false) => {
  const m = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(optional ? 0 : 1).setMaxValues(1);
  if (current) m.setDefaultRoles(current);
  return new ActionRowBuilder().addComponents(m);
};

const POST_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
const pretty = (flag) => flag.replace(/([a-z])([A-Z])/g, '$1 $2');   // SendMessages -> Send Messages

/** Permissions the bot lacks in a channel (empty list = fine). */
function missingIn(channel, guild, perms = POST_PERMS) {
  const p = channel.permissionsFor(guild.members.me);
  return perms.filter(x => !p?.has(PermissionFlagsBits[x])).map(pretty);
}

/**
 * The server's own announcement channel: a news (announcement) channel, or the Updates channel of a Community server.
 * Offered as a one-tap choice wherever a setup page asks for a channel.
 */
function announcementChannel(guild) {
  return guild.channels.cache.find(c => c.type === ChannelType.GuildAnnouncement && c.viewable) || guild.publicUpdatesChannel || null;
}
const announcementButton = (id, guild) => {
  const c = announcementChannel(guild);
  return c ? new ButtonBuilder().setCustomId(id).setLabel(`Use #${c.name}`.slice(0, 80)).setStyle(ButtonStyle.Secondary) : null;
};

/** Answer a setup interaction by editing the screen in place (or opening it fresh from a command). */
async function respond(interaction, view) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(view);
  if (interaction.isFromMessage?.() || interaction.isMessageComponent?.()) return interaction.update(view);
  return interaction.reply({ ...view, flags: ephemeral });
}

module.exports = {
  BLUE, GREEN, AMBER, RED, ephemeral,
  chan, role, onOff, noteBad, noteGood, backButton, channelSelect, roleSelect,
  POST_PERMS, pretty, missingIn, respond, announcementChannel, announcementButton,
};
