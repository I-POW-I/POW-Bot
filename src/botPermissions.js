/**
 * Everything the bot needs from Discord, in one place.
 * Used by the owner hub (server details). `permissionInteger()` is the number to enter in the Developer Portal.
 * If a feature starts needing a new permission, add it here and nowhere else.
 */

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const LABELS = {
  ViewChannel: 'View Channels', SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History', Connect: 'Connect', Speak: 'Speak', ManageRoles: 'Manage Roles',
  KickMembers: 'Kick Members', ManageMessages: 'Manage Messages', ViewAuditLog: 'View Audit Log',
};

/** What each permission is for. `serverWide` ones are checked on the server, the rest per channel. */
const REQUIRED = [
  { perm: 'ViewChannel',        why: 'See the channels it posts in' },
  { perm: 'SendMessages',       why: 'Post the panel, logs, alerts and announcements' },
  { perm: 'EmbedLinks',         why: 'Show embeds' },
  { perm: 'AttachFiles',        why: 'Welcome and leave cards' },
  { perm: 'ReadMessageHistory', why: 'Update the voice panel message and /purge' },
  { perm: 'Connect',            why: 'Join voice channels', serverWide: true },
  { perm: 'Speak',              why: 'Stay connected in voice', serverWide: true },
  { perm: 'ManageRoles',        why: 'Verification and voice reward roles', serverWide: true },
  { perm: 'KickMembers',        why: 'Verification: remove members who never verify', serverWide: true },
  { perm: 'ManageMessages',     why: '/purge', serverWide: true },
  { perm: 'ViewAuditLog',       why: 'Show who made a change in the logs', serverWide: true },
];

const label = (perm) => LABELS[perm] || perm;

/** The number to use as the bot's permissions in the Developer Portal and the invite link. */
const permissionInteger = () => new PermissionsBitField(REQUIRED.map(r => r.perm)).bitfield.toString();

/** Server-wide permissions the bot is missing, as readable names. */
function missingServerWide(guild) {
  const me = guild.members.me;
  return REQUIRED.filter(r => r.serverWide && !me?.permissions.has(PermissionFlagsBits[r.perm])).map(r => label(r.perm));
}

module.exports = { REQUIRED, label, permissionInteger, missingServerWide };
