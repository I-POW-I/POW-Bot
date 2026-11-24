/**
 * Moderation core: numbered cases, the checks every command shares, the message to the member and the mod log.
 *
 * Every action is a case. Cases are numbered per server (Case #1, #2, ...) and kept until the bot leaves the server,
 * so /case and /history always show a member's full record. Actions taken by hand in Discord (a ban from the member
 * list, a kick, a timeout) are recorded too, see events/guildAuditLogEntryCreate.js.
 *
 * The commands in commands/ only collect options and call perform(); everything that can go wrong lives here.
 */

const { EmbedBuilder, PermissionFlagsBits: P } = require('discord.js');
const { run, selectOne, selectAll } = require('./database');
const { getGuildConfig, getLogChannel } = require('./guildConfig');
const { log } = require('./logger');
const { duration } = require('./duration');

const MAX_TIMEOUT = 28 * 86_400_000;

const ACTIONS = {
  warn:      { label: 'Warn',       past: 'warned',          colour: 0xFEE75C },
  timeout:   { label: 'Timeout',    past: 'timed out',       colour: 0xFAA61A },
  untimeout: { label: 'Timeout removed', past: 'had their timeout removed', colour: 0x57F287 },
  kick:      { label: 'Kick',       past: 'kicked',          colour: 0xFF7043 },
  softban:   { label: 'Softban',    past: 'softbanned',      colour: 0xED4245 },
  ban:       { label: 'Ban',        past: 'banned',          colour: 0xED4245 },
  unban:     { label: 'Unban',      past: 'unbanned',        colour: 0x57F287 },
};

const NEEDS = { timeout: 'ModerateMembers', untimeout: 'ModerateMembers', kick: 'KickMembers', softban: 'BanMembers', ban: 'BanMembers', unban: 'BanMembers' };
const NEEDS_LABEL = { ModerateMembers: 'Timeout Members', KickMembers: 'Kick Members', BanMembers: 'Ban Members' };
const DELETE_CHOICES = { none: 0, '1h': 3600, '1d': 86_400, '7d': 604_800 };

// ── Settings ──────────────────────────────────────────────────────────────────

/** Per server: whether members get a message when something is done to them. On unless staff turn it off. */
function settings(guildId) {
  const s = getGuildConfig(guildId).moderation || {};
  return { dm: s.dm !== false };
}

// ── Durations ─────────────────────────────────────────────────────────────────

/** "30m", "2h", "1d12h", "1 week" -> milliseconds, or null when it can't be read. */
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const units = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
    h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, week: 6048e5, weeks: 6048e5 };
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0, m;
  while ((m = re.exec(t))) {
    if (!units[m[2]]) return null;
    total += parseFloat(m[1]) * units[m[2]];
  }
  // Anything left over once the "30m" parts are removed means it wasn't a duration
  const rest = t.replace(re, '').replace(/[\s,]|and/g, '');
  return total > 0 && !rest ? Math.round(total) : null;
}

// ── Cases ─────────────────────────────────────────────────────────────────────

const tagOf = (u) => u?.tag || u?.username || u?.id || null;

/** Record a case and return it (with its number). */
function createCase({ guildId, user, moderator, action, reason, durationMs = null }) {
  const next = Number(selectOne('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM mod_cases WHERE guild_id = ?', [guildId])?.n || 1);
  run(`INSERT INTO mod_cases (guild_id, number, user_id, user_tag, mod_id, mod_tag, action, reason, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, next, user.id, tagOf(user), moderator?.id || null, tagOf(moderator), action, reason || null, durationMs, Date.now()]);
  return getCase(guildId, next);
}

const getCase = (guildId, number) => selectOne('SELECT * FROM mod_cases WHERE guild_id = ? AND number = ?', [guildId, number]);
const history = (guildId, userId, limit = 50) => selectAll('SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY number DESC LIMIT ?', [guildId, userId, limit]);
const counts = (guildId, userId) => Object.fromEntries(selectAll('SELECT action, COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND user_id = ? GROUP BY action', [guildId, userId]).map(r => [r.action, Number(r.n)]));

function setReason(guildId, number, reason) {
  run('UPDATE mod_cases SET reason = ? WHERE guild_id = ? AND number = ?', [reason, guildId, number]);
  return getCase(guildId, number);
}

// ── Showing a case ────────────────────────────────────────────────────────────

const when = (ms) => `<t:${Math.floor(ms / 1000)}:f> (<t:${Math.floor(ms / 1000)}:R>)`;

function caseEmbed(c, { user = null } = {}) {
  const a = ACTIONS[c.action] || { label: c.action, colour: 0x5865F2 };
  const embed = new EmbedBuilder().setColor(a.colour).setTitle(`Case #${c.number} · ${a.label}`)
    .addFields(
      { name: 'Member', value: `<@${c.user_id}>${c.user_tag ? ` · \`${c.user_tag}\`` : ''}\nID \`${c.user_id}\``, inline: true },
      { name: 'Moderator', value: c.mod_id ? `<@${c.mod_id}>` : '*Unknown*', inline: true },
    );
  if (c.duration_ms) embed.addFields({ name: 'Length', value: duration(c.duration_ms), inline: true });
  embed.addFields({ name: 'Reason', value: (c.reason || 'No reason given').slice(0, 1000), inline: false }, { name: 'When', value: when(c.created_at), inline: false });
  if (user?.displayAvatarURL) embed.setThumbnail(user.displayAvatarURL());
  return embed;
}

/** One line per case, for /history. */
const caseLine = (c) => `**#${c.number}** · ${(ACTIONS[c.action] || { label: c.action }).label} · <t:${Math.floor(c.created_at / 1000)}:d>${c.duration_ms ? ` · ${duration(c.duration_ms)}` : ''}\n${(c.reason || 'No reason given').slice(0, 120)}`;

async function sendLog(guild, embed) {
  const id = getLogChannel(guild.id, 'modlog');
  const channel = id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(err => log('WARN', 'Moderation: could not write the mod log', { guild: guild.name, err }));
}

// ── The message to the member ─────────────────────────────────────────────────

const DM_LINES = {
  warn:      (g) => `You received a warning in **${g}**.`,
  timeout:   (g, c) => `You were timed out in **${g}** for ${duration(c.duration_ms)}.`,
  untimeout: (g) => `Your timeout in **${g}** was removed.`,
  kick:      (g) => `You were kicked from **${g}**. You can rejoin if you have an invite.`,
  softban:   (g) => `You were removed from **${g}** and your recent messages were deleted. You can rejoin if you have an invite.`,
  ban:       (g) => `You were banned from **${g}**.`,
  unban:     (g) => `You were unbanned from **${g}**.`,
};

async function notify(guild, user, c) {
  if (!settings(guild.id).dm || !user?.send) return false;
  const embed = new EmbedBuilder().setColor((ACTIONS[c.action] || {}).colour || 0x5865F2)
    .setTitle(`${ACTIONS[c.action]?.label || 'Moderation action'} · Case #${c.number}`)
    .setDescription([DM_LINES[c.action](guild.name, c), '', `**Reason:** ${(c.reason || 'No reason given').slice(0, 800)}`,
      c.action === 'ban' ? '\nIf you think this is a mistake, contact the server staff.' : null].filter(v => v != null).join('\n'));
  return user.send({ embeds: [embed] }).then(() => true).catch(() => false);
}

// ── Checks every command shares ───────────────────────────────────────────────

/**
 * Why this moderator can't do this to this person, in plain words. Returns null when it is fine.
 * `member` is the target as a server member (null when they are not in the server).
 */
function blocker(interaction, user, member, action) {
  const { guild, client } = interaction;
  const me = guild.members.me;
  const need = NEEDS[action];
  if (need && !me.permissions.has(P[need])) return `I need the **${NEEDS_LABEL[need]}** permission to do that. Give it to my role in Server Settings > Roles.`;
  if (user.id === interaction.user.id) return 'You can\'t do that to yourself.';
  if (user.id === client.user.id) return 'You can\'t do that to me.';
  if (user.bot && action === 'warn') return 'Bots can\'t be warned.';
  if (user.id === guild.ownerId) return 'You can\'t do that to the server owner.';
  if (member) {
    if (interaction.user.id !== guild.ownerId && interaction.member.roles.highest.position <= member.roles.highest.position) return 'Their highest role is the same as or above yours.';
    const can = { kick: member.kickable, ban: member.bannable, softban: member.bannable, timeout: member.moderatable, untimeout: member.moderatable }[action];
    if (can === false) return 'Their highest role is above mine, so I can\'t do that. Move my role higher in Server Settings > Roles.';
    if (action === 'timeout' && member.permissions.has(P.Administrator)) return 'Administrators can\'t be timed out.';
  }
  return null;
}

const reasonFor = (interaction, reason) => `${tagOf(interaction.user)}: ${reason}`.slice(0, 500);

/**
 * Run one action end to end: checks, message to the member, the action itself, the case and the mod log.
 * Returns { ok, text, case }. `text` is what to tell the moderator.
 */
async function perform(interaction, { action, user, reason, durationMs = null, deleteSeconds = 0 }) {
  const { guild } = interaction;
  const why = (reason || '').trim() || 'No reason given';
  const member = await guild.members.fetch(user.id).catch(() => null);

  if (['kick', 'timeout', 'untimeout', 'warn'].includes(action) && !member) return { ok: false, text: 'That person is not in this server.' };
  const blocked = blocker(interaction, user, member, action);
  if (blocked) return { ok: false, text: blocked };

  const auditReason = reasonFor(interaction, why);
  const draft = { action, reason: why, duration_ms: durationMs, number: '…' };
  let dmSent = false;
  try {
    // The message goes first: after a kick or ban Discord won't deliver it
    if (['kick', 'softban', 'ban', 'timeout', 'warn'].includes(action)) dmSent = await notify(guild, user, { ...draft, number: (Number(selectOne('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM mod_cases WHERE guild_id = ?', [guild.id])?.n) || 1) });
    if (action === 'kick')      await member.kick(auditReason);
    if (action === 'ban')       await guild.members.ban(user.id, { deleteMessageSeconds: deleteSeconds, reason: auditReason });
    if (action === 'softban') {
      await guild.members.ban(user.id, { deleteMessageSeconds: deleteSeconds || 86_400, reason: auditReason });
      await guild.members.unban(user.id, 'Softban: ' + auditReason).catch(err => { throw Object.assign(new Error(`they were banned but the unban failed (${err.message}). Unban them with /unban`), { partial: true }); });
    }
    if (action === 'timeout')   await member.timeout(durationMs, auditReason);
    if (action === 'untimeout') await member.timeout(null, auditReason);
    if (action === 'unban')     await guild.members.unban(user.id, auditReason);
  } catch (err) {
    if (err.partial) {
      const c = createCase({ guildId: guild.id, user, moderator: interaction.user, action: 'ban', reason: why });
      await sendLog(guild, caseEmbed(c, { user }));
      return { ok: false, text: `Partly done: ${err.message}.`, case: c };
    }
    const text = /unknown ban/i.test(err.message) ? 'That person is not banned.' : /Missing Permissions|50013/i.test(err.message + err.code) ? 'Discord refused. My role is probably below theirs, or I lack the permission.' : `Discord refused: ${err.message}`;
    return { ok: false, text };
  }

  const c = createCase({ guildId: guild.id, user, moderator: interaction.user, action, reason: why, durationMs });
  if (action === 'untimeout' || action === 'unban') dmSent = await notify(guild, user, c);
  await sendLog(guild, caseEmbed(c, { user }));
  const dmNote = !settings(guild.id).dm ? '' : dmSent ? ' They were sent a message.' : ' I couldn\'t message them (their DMs are closed).';
  return { ok: true, case: c, text: `**Case #${c.number}** · ${user} was ${ACTIONS[action].past}${durationMs ? ` for ${duration(durationMs)}` : ''}.${dmNote}` };
}

/**
 * An action the bot takes by itself (raid protection, AutoMod): the member is told first, then the action is done,
 * recorded as a case and written to the mod log, exactly like one done by a moderator.
 * `member` may be null for a ban. Returns { ok, text, case }.
 */
async function auto(guild, user, member, { action, reason, durationMs = null, deleteSeconds = 0, log: writeLog = true }) {
  const me = guild.members.me;
  const needs = NEEDS[action];
  if (needs && !me?.permissions.has(P[needs])) return { ok: false, text: `I need the **${NEEDS_LABEL[needs]}** permission to ${action} someone.` };
  if (member && (member.id === guild.ownerId || (member.roles?.highest && me?.roles.highest && member.roles.highest.comparePositionTo(me.roles.highest) >= 0))) {
    return { ok: false, text: 'Their highest role is not below mine, so I cannot act on them.' };
  }
  const c = { action, reason, duration_ms: durationMs, number: 0 };
  try {
    let dmSent = false;
    if (action !== 'warn') {   // told before the action, while a message can still reach them
      const preview = { ...c, number: (selectOne('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM mod_cases WHERE guild_id = ?', [guild.id])?.n || 1) };
      dmSent = await notify(guild, user, preview);
    }
    if (action === 'timeout') { if (!member) return { ok: false, text: 'They had already left.' }; await member.timeout(Math.min(durationMs || 600_000, MAX_TIMEOUT), reason); }
    else if (action === 'kick') { if (!member) return { ok: false, text: 'They had already left.' }; await member.kick(reason); }
    else if (action === 'ban') await guild.members.ban(user.id, { deleteMessageSeconds: deleteSeconds, reason });
    else if (action === 'softban') { await guild.members.ban(user.id, { deleteMessageSeconds: deleteSeconds, reason }); await guild.members.unban(user.id, reason).catch(() => {}); }
    const made = createCase({ guildId: guild.id, user, moderator: guild.client.user, action, reason, durationMs });
    if (action === 'warn') await notify(guild, user, made);
    if (writeLog) await sendLog(guild, caseEmbed(made, { user }));
    return { ok: true, case: made, dmSent, text: `Case #${made.number}` };
  } catch (err) {
    const hierarchy = /Missing Permissions|50013/i.test(String(err.message) + String(err.code));
    return { ok: false, text: hierarchy ? 'Their highest role is above mine, or I lack the permission.' : `Failed: ${err.message}` };
  }
}

module.exports = {
  ACTIONS, DELETE_CHOICES, MAX_TIMEOUT, settings, parseDuration, createCase, getCase, history, counts, setReason,
  caseEmbed, caseLine, sendLog, notify, blocker, perform, auto, tagOf,
};
