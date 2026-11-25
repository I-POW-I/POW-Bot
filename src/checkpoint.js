/**
 * Security Check Point.
 *
 * A channel that exists only to catch spam bots and hacked accounts. They post the same message in every channel
 * they can see, so one of those posts lands here. Real members have no reason to type in it, so whoever does is
 * dealt with automatically and the action is logged.
 *
 * Staff pick the channel (or let the bot create it), what happens to anyone who posts there, and where it is logged.
 * Members with a staff permission, and any roles the server chooses, are never actioned.
 *
 * Settings live in the server's config under `checkpoint` (see settings()).
 */

const { EmbedBuilder, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { getGuildConfig, setGuildConfig, getLogChannel } = require('./guildConfig');
const { log } = require('./logger');
const { duration } = require('./duration');

const HOUR = 3_600_000;

const ACTIONS = {
  softban: { label: 'Softban', short: 'softbanned', desc: 'Remove them and delete their recent messages. They can rejoin.', needs: 'BanMembers' },
  kick:    { label: 'Kick',    short: 'kicked',     desc: 'Remove them. Their other messages stay.',                          needs: 'KickMembers' },
  ban:     { label: 'Ban',     short: 'banned',     desc: 'Remove them for good and delete their recent messages.',            needs: 'BanMembers' },
  timeout: { label: 'Timeout', short: 'timed out',  desc: 'Mute them for a while. Staff decide what happens next.',            needs: 'ModerateMembers' },
};

const TIMEOUTS = { '1h': HOUR, '1d': 24 * HOUR, '1w': 7 * 24 * HOUR };
const DELETE_WINDOWS = { '1h': HOUR, '1d': 24 * HOUR, '7d': 7 * 24 * HOUR };
const NEEDS_LABEL = { BanMembers: 'Ban Members', KickMembers: 'Kick Members', ModerateMembers: 'Timeout Members' };

const DEFAULTS = {
  enabled: false, channelId: null, messageId: null, logChannelId: null,
  action: 'softban', timeout: '1d', deleteWindow: '1d', dm: true, exemptRoleIds: [], caught: 0,
};

function settings(guildId) {
  const s = { ...DEFAULTS, ...(getGuildConfig(guildId).checkpoint || {}) };
  if (!ACTIONS[s.action]) s.action = DEFAULTS.action;
  if (!TIMEOUTS[s.timeout]) s.timeout = DEFAULTS.timeout;
  if (!DELETE_WINDOWS[s.deleteWindow]) s.deleteWindow = DEFAULTS.deleteWindow;
  s.exemptRoleIds = Array.isArray(s.exemptRoleIds) ? s.exemptRoleIds : [];
  return s;
}

function save(guildId, s) { setGuildConfig(guildId, { checkpoint: { ...DEFAULTS, ...s } }); }

/** What the server has chosen, in words: "softbanned", "timed out for 1 day". */
function actionText(s) {
  return s.action === 'timeout' ? `timed out for ${duration(TIMEOUTS[s.timeout])}` : ACTIONS[s.action].short;
}

// ── Who is never actioned ─────────────────────────────────────────────────────

const STAFF_PERMS = [P.Administrator, P.ManageGuild, P.ManageMessages, P.ManageChannels, P.KickMembers, P.BanMembers, P.ModerateMembers];

function isExempt(member, s) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (STAFF_PERMS.some(p => member.permissions.has(p))) return true;
  return s.exemptRoleIds.some(id => member.roles.cache.has(id));
}

// ── The warning message in the channel ────────────────────────────────────────

function warningMessage(s) {
  return {
    embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('⛔ Do not post in this channel')
      .setDescription([
        'This channel is a trap for spam bots and hacked accounts.',
        `Anyone who sends a message here is **${actionText(s)}** automatically.`,
        '',
        'Nothing happens in this channel, so there is no reason to type in it. If you can read this, you are fine: just do not post.',
      ].join('\n'))],
  };
}

/** Post the warning, or refresh the one that is already there. */
async function postWarning(guild, channel, s) {
  if (s.messageId) {
    const old = await channel.messages.fetch(s.messageId).catch(() => null);
    if (old) { await old.edit(warningMessage(s)); return old.id; }
  }
  const sent = await channel.send(warningMessage(s));
  await sent.pin().catch(() => {});
  return sent.id;
}

/** Create the trap channel, visible to everyone and placed at the top, then post the warning in it. */
async function createChannel(guild, by) {
  const me = guild.members.me;
  const channel = await guild.channels.create({
    name: 'do-not-post', type: ChannelType.GuildText, position: 0,
    topic: 'Do not post here. Anything sent in this channel gets you removed from the server.',
    reason: `Security Check Point created by ${by?.tag || by?.username || 'staff'}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory], deny: [P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.AttachFiles] },
      { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ManageMessages, P.ReadMessageHistory, P.ManageChannels] },
    ],
  });
  return channel;
}

// ── Checks ─────────────────────────────────────────────────────────────────────

/** Plain-language problems that would stop it working. Empty means it is ready. */
function diagnose(guild) {
  const s = settings(guild.id), me = guild.members.me, problems = [];
  if (!s.channelId) return ['No channel chosen yet.'];
  const channel = guild.channels.cache.get(s.channelId);
  if (!channel) return ['The channel was deleted. Choose or create one again.'];
  const here = channel.permissionsFor(me);
  const lacking = [[P.ViewChannel, 'View Channel'], [P.ManageMessages, 'Manage Messages']].filter(([p]) => !here?.has(p)).map(([, n]) => n);
  if (lacking.length) problems.push(`I need **${lacking.join(' and ')}** in ${channel} to delete what they post.`);
  const need = ACTIONS[s.action].needs;
  if (!me.permissions.has(P[need])) problems.push(`**${ACTIONS[s.action].label}** needs the **${NEEDS_LABEL[need]}** permission, which I don't have.`);
  const logId = s.logChannelId || getLogChannel(guild.id, 'modlog');
  if (!logId) problems.push('No log channel is set, so catches will not be logged. Choose one below, or set a Moderation log in **Logs**.');
  else {
    const lc = guild.channels.cache.get(logId);
    if (!lc) problems.push('The log channel was deleted. Choose it again.');
    else if (!lc.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) problems.push(`I can't post in ${lc}. I need View Channel, Send Messages and Embed Links there.`);
  }
  return problems;
}

// ── The log entry ─────────────────────────────────────────────────────────────

const trim = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);

function logEntry({ user, member, message, result, s, test }) {
  const embed = new EmbedBuilder()
    .setColor(test ? 0x5865F2 : result.ok ? 0xED4245 : 0xFAA61A)
    .setTitle(test ? 'Security Check Point · test' : `Security Check Point · ${result.ok ? ACTIONS[s.action].label : 'could not act'}`)
    .setThumbnail(user.displayAvatarURL?.() || null)
    .addFields(
      { name: 'Member', value: `${user} · \`${user.tag || user.username}\`\nID \`${user.id}\``, inline: false },
      { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Joined the server', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Result', value: test ? 'This is a test. Nobody was actioned.' : result.text, inline: false },
    );
  const text = (message?.content || '').trim();
  const files = message?.attachments?.size || 0;
  embed.addFields({ name: 'What they posted', value: text ? `\`\`\`${trim(text.replace(/`/g, "'"), 900)}\`\`\`` : files ? `*No text, ${files} attachment${files === 1 ? '' : 's'}*` : '*No text*', inline: false });
  return embed;
}

async function sendLog(guild, s, embed) {
  const id = s.logChannelId || getLogChannel(guild.id, 'modlog');
  const channel = id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(err => log('WARN', 'Security Check Point: could not write the log', { guild: guild.name, err }));
}

// ── The action ─────────────────────────────────────────────────────────────────

const inFlight = new Set();   // one action per member at a time, however many messages they post

function dmFor(guild, s) {
  const lines = {
    softban: 'You were removed because you posted in a channel that exists only to catch spam bots and hacked accounts. If this was really you, you are free to rejoin. If your account was hacked, change your password and turn on two factor authentication first.',
    kick:    'You were removed because you posted in a channel that exists only to catch spam bots and hacked accounts. If this was really you, you are free to rejoin. If your account was hacked, change your password and turn on two factor authentication first.',
    ban:     'You were banned because you posted in a channel that exists only to catch spam bots and hacked accounts. If this was a mistake, contact the server staff.',
    timeout: `You were timed out for ${duration(TIMEOUTS[s.timeout])} because you posted in a channel that exists only to catch spam bots and hacked accounts. If your account was hacked, change your password and turn on two factor authentication.`,
  };
  return { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle(`Security check in ${guild.name}`).setDescription(lines[s.action])] };
}

/** Do what the server chose. Returns { ok, text } and never throws. */
async function act(guild, user, member, s) {
  const reason = 'Security Check Point: posted in the trap channel';
  const seconds = Math.floor(DELETE_WINDOWS[s.deleteWindow] / 1000);
  try {
    if (s.dm) await user.send(dmFor(guild, s)).catch(() => {});   // before the action, while a DM can still be sent
    if (s.action === 'softban') {
      await guild.members.ban(user.id, { deleteMessageSeconds: seconds, reason });
      await guild.members.unban(user.id, reason).catch(err => { throw Object.assign(new Error(`banned, but the unban failed: ${err.message}`), { partial: true }); });
      return { ok: true, text: `Softbanned. Their messages from the last ${duration(DELETE_WINDOWS[s.deleteWindow])} were deleted and they can rejoin.` };
    }
    if (s.action === 'ban') {
      await guild.members.ban(user.id, { deleteMessageSeconds: seconds, reason });
      return { ok: true, text: `Banned. Their messages from the last ${duration(DELETE_WINDOWS[s.deleteWindow])} were deleted.` };
    }
    if (!member) return { ok: false, text: 'They had already left the server.' };
    if (s.action === 'kick') { await member.kick(reason); return { ok: true, text: 'Kicked.' }; }
    await member.timeout(TIMEOUTS[s.timeout], reason);
    return { ok: true, text: `Timed out for ${duration(TIMEOUTS[s.timeout])}.` };
  } catch (err) {
    const hierarchy = /Missing Permissions|50013/i.test(String(err.message) + String(err.code));
    return { ok: false, text: err.partial ? `Partly done: ${err.message}.` : hierarchy ? `I could not ${ACTIONS[s.action].label.toLowerCase()} them. Their highest role is above mine, or I lack the permission. Move my role higher in Server Settings > Roles.` : `Failed: ${err.message}` };
  }
}

/** Called for every new message. Does nothing unless it was posted in a server's trap channel. */
async function handleMessage(message) {
  const guild = message.guild;
  if (!guild || message.author.bot || message.webhookId || message.system) return;
  const s = settings(guild.id);
  if (!s.enabled || message.channelId !== s.channelId || !require('./globalConfig').featureEnabled('checkpoint', message.guild?.id)) return;   // global switch (/owner)

  const key = `${guild.id}:${message.author.id}`;
  if (inFlight.has(key)) { await message.delete().catch(() => {}); return; }

  const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
  if (isExempt(member, s)) return;

  inFlight.add(key);
  try {
    await message.delete().catch(() => {});
    const result = await act(guild, message.author, member, s);
    if (result.ok) {
      save(guild.id, { ...s, caught: s.caught + 1 });
      try {   // it is a case like any other, so /history shows it
        const c = require('./moderation').createCase({ guildId: guild.id, user: message.author, moderator: guild.client.user, action: s.action,
          reason: 'Security Check Point: posted in the trap channel', durationMs: s.action === 'timeout' ? TIMEOUTS[s.timeout] : null });
        result.text += ` Case #${c.number}.`;
      } catch (err) { log('WARN', 'Security Check Point: could not record the case', { err }); }
    }
    log('INFO', `Security Check Point: ${message.author.tag} in ${guild.name}: ${result.text}`);
    await sendLog(guild, s, logEntry({ user: message.author, member, message, result, s }));
  } catch (err) {
    log('WARN', 'Security Check Point failed', { guild: guild.name, err });
  } finally {
    setTimeout(() => inFlight.delete(key), 30_000).unref?.();   // a second post right after the first is simply deleted
  }
}

/** Sends a clearly marked sample entry to the log channel. Returns true if it could. */
async function sendTest(guild, by) {
  const s = settings(guild.id);
  const id = s.logChannelId || getLogChannel(guild.id, 'modlog');
  if (!id) return false;
  const member = guild.members.cache.get(by.id) || await guild.members.fetch(by.id).catch(() => null);
  await sendLog(guild, s, logEntry({ user: by, member, message: { content: 'Sample message from the test button', attachments: { size: 0 } }, result: { ok: true, text: '' }, s, test: true }));
  return true;
}

module.exports = {
  ACTIONS, TIMEOUTS, DELETE_WINDOWS, settings, save, actionText, isExempt, warningMessage, postWarning, createChannel,
  diagnose, handleMessage, sendTest, logEntry, act,
};
