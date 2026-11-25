/**
 * What the server logs, and what each log is made of.
 *
 * A log is on when a channel is chosen for it (src/guildConfig.js: logChannels). Some logs are made of several
 * kinds of event, and staff can switch each kind off. Message logs can also ignore chosen channels.
 *
 * Stored in the server's config:  logOff: ['roles', ...]  ·  logIgnoreChannelIds: [...]
 */

const { AuditLogEvent: A } = require('discord.js');
const { getGuildConfig, getLogChannel } = require('./guildConfig');

const LOG_TYPES = [
  { key: 'voice',    label: 'Voice activity',        desc: 'Joins, leaves and moves in voice channels' },
  { key: 'messages', label: 'Message logs',          desc: 'Deleted and edited messages (text is kept 7 days so this works)' },
  { key: 'members',  label: 'Member join/leave + verification', desc: 'Detailed join log and verification results (staff only)' },
  { key: 'server',   label: 'Server changes',        desc: 'Channels, roles, emoji, invites, threads, AutoMod, who did it' },
  { key: 'modlog',   label: 'Moderation actions',    desc: 'Cases: kicks, bans, timeouts, warnings' },
  { key: 'commands', label: 'Command & button logs', desc: 'Every command and button used' },
];

/** The kinds of event inside a log that staff can switch off. */
const EVENTS = {
  voice: [
    { key: 'vcJoin',   label: 'Joins',                   desc: 'Someone joins a voice channel' },
    { key: 'vcLeave',  label: 'Leaves',                  desc: 'Someone leaves, or is disconnected by a moderator' },
    { key: 'vcMove',   label: 'Moves',                   desc: 'Someone changes channel, or is moved by a moderator' },
    { key: 'vcMute',   label: 'Server mutes and deafens', desc: 'A moderator mutes or deafens someone' },
    { key: 'vcStream', label: 'Streams',                 desc: 'Someone starts or stops streaming' },
    { key: 'vcBot',    label: 'Bot dragged out',         desc: 'When someone drags this bot out of its channel' },
  ],
  messages: [
    { key: 'msgDelete', label: 'Deleted messages' },
    { key: 'msgEdit',   label: 'Edited messages' },
    { key: 'msgBulk',   label: 'Bulk deletes (purge)' },
  ],
  server: [
    { key: 'channels',  label: 'Channels',              desc: 'Created, deleted, renamed, permissions changed', actions: [A.ChannelCreate, A.ChannelDelete, A.ChannelUpdate, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete] },
    { key: 'roles',     label: 'Roles',                 desc: 'Created, deleted, edited',                        actions: [A.RoleCreate, A.RoleDelete, A.RoleUpdate] },
    { key: 'memberroles', label: 'Member roles',        desc: 'Roles given to or taken from someone',            actions: [A.MemberRoleUpdate] },
    { key: 'nicknames', label: 'Nicknames',             desc: 'Nickname changes',                                actions: [A.MemberUpdate] },
    { key: 'emoji',     label: 'Emoji and stickers',    desc: 'Added, edited, removed',                          actions: [A.EmojiCreate, A.EmojiDelete, A.EmojiUpdate, A.StickerCreate, A.StickerDelete, A.StickerUpdate] },
    { key: 'invites',   label: 'Invites',               desc: 'Created and deleted',                             actions: [A.InviteCreate, A.InviteDelete] },
    { key: 'threads',   label: 'Threads',               desc: 'Created, deleted, changed',                       actions: [A.ThreadCreate, A.ThreadDelete, A.ThreadUpdate] },
    { key: 'webhooks',  label: 'Webhooks, bots and apps', desc: 'Added or removed',                              actions: [A.WebhookCreate, A.WebhookDelete, A.WebhookUpdate, A.BotAdd, A.IntegrationCreate, A.IntegrationDelete] },
    { key: 'server',    label: 'Server settings',       desc: 'Name, icon, verification level and so on',        actions: [A.GuildUpdate] },
    { key: 'automod',   label: 'AutoMod',               desc: "Discord's AutoMod rules changed or a message blocked", actions: [A.AutoModerationRuleCreate, A.AutoModerationRuleUpdate, A.AutoModerationRuleDelete, A.AutoModerationBlockMessage, A.AutoModerationFlagToChannel, A.AutoModerationUserCommunicationDisabled] },
    { key: 'events',    label: 'Scheduled events',      desc: 'Created, changed, cancelled',                     actions: [A.GuildScheduledEventCreate, A.GuildScheduledEventUpdate, A.GuildScheduledEventDelete] },
  ],
};

const off = (guildId) => new Set(getGuildConfig(guildId).logOff || []);

/** Is this kind of event being logged? (Everything is on until staff switch it off.) */
const enabled = (guildId, key) => !off(guildId).has(key);

/** Which group does an audit log action belong to? */
const groupOf = (action) => EVENTS.server.find(g => g.actions.includes(action))?.key || null;

const ignoredChannels = (guildId) => getGuildConfig(guildId).logIgnoreChannelIds || [];
const isIgnored = (guildId, channelId) => !!channelId && ignoredChannels(guildId).includes(channelId);

const ignoredRoles = (guildId) => getGuildConfig(guildId).logIgnoreRoleIds || [];
const ignoredUsers = (guildId) => getGuildConfig(guildId).logIgnoreUserIds || [];

/**
 * Is this author on the message logs' ignore lists? Checks the person (members and bots alike) and their roles.
 * `member` is optional: when it is missing the server's member cache is tried.
 */
function authorIgnored(guild, userId, member = null) {
  if (!guild || !userId) return false;
  if (ignoredUsers(guild.id).includes(userId)) return true;
  const roles = ignoredRoles(guild.id);
  if (!roles.length) return false;
  const m = member || guild.members?.cache?.get(userId);
  return !!m?.roles?.cache && roles.some(r => m.roles.cache.has(r));
}

/** Where server changes go. Servers that never chose a Server log keep getting them in the Moderation log, as before. */
const serverLogChannel = (guildId) => getLogChannel(guildId, 'server') || getLogChannel(guildId, 'modlog');

/** Server changes can be sent to a channel of their own per kind (channels, roles, invites...). Unrouted kinds use the Server log. */
const routes = (guildId) => getGuildConfig(guildId).logRoutes || {};
const serverRoute = (guildId, group) => routes(guildId)[group] || serverLogChannel(guildId);

module.exports = { LOG_TYPES, EVENTS, enabled, off, groupOf, ignoredChannels, isIgnored, ignoredRoles, ignoredUsers, authorIgnored, serverLogChannel, routes, serverRoute };
