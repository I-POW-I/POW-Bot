/**
 * Raid protection.
 *
 *   Detection      Too many people joining in a short time raises an alert, and can switch on raid mode by itself.
 *   Raid mode      While it is on, new members who match the server's rule are actioned (kick, timeout or ban),
 *                  and invites are paused so no new people can come in. It ends after a set time, or when staff end it.
 *   Account gate   Accounts younger than a chosen age are actioned on arrival, whether or not a raid is happening.
 *
 * Staff choose every number and every response in /setup > Raid protection. Settings live in the server's config
 * under `raid`. Nothing about joins is stored beyond the existing 90 day join history.
 */

const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, setGuildConfig, getLogChannel } = require('./guildConfig');
const { log } = require('./logger');
const { duration, age } = require('./duration');

const MINUTE = 60_000, DAY = 86_400_000;

const RESPONSES = {
  alert: { label: 'Alert staff only',        desc: 'Post an alert and let staff decide' },
  mode:  { label: 'Start raid mode',         desc: 'Alert staff, then act on new joins and pause invites' },
};
const ACTIONS = {
  kick:    { label: 'Kick',    short: 'kicked',        needs: 'KickMembers',     desc: 'Remove them. They can rejoin once raid mode is over.' },
  timeout: { label: 'Timeout', short: 'timed out',     needs: 'ModerateMembers', desc: 'Mute them for a day so staff can look at them.' },
  ban:     { label: 'Ban',     short: 'banned',        needs: 'BanMembers',      desc: 'Remove them for good.' },
};
const TARGETS = {
  all:      { label: 'Everyone who joins',               desc: 'Strictest. Real people are turned away too' },
  young:    { label: 'Accounts under a set age',          desc: 'Recommended. Raiders use brand new accounts' },
  noavatar: { label: 'Accounts with no profile picture',  desc: 'Catches lazy bots, rarely real people' },
  either:   { label: 'New accounts or no profile picture', desc: 'Catches both' },
};
const MODE_LENGTHS = { 0: 'Until staff end it', 10: '10 minutes', 30: '30 minutes', 60: '1 hour', 360: '6 hours', 1440: '1 day' };

const DEFAULTS = {
  enabled: false, joins: 8, seconds: 30, response: 'mode', sweep: true,
  modeAction: 'kick', modeTarget: 'young', modeYoungDays: 7, modeMinutes: 30, pauseInvites: true,
  gateEnabled: false, gateDays: 3, gateAction: 'kick',
  dm: true, alertChannelId: null, pingRoleId: null,
  active: false, until: 0, startedBy: null, startedAt: 0, invitesPausedByUs: false, caught: 0, raids: 0,
};

function settings(guildId) {
  const s = { ...DEFAULTS, ...(getGuildConfig(guildId).raid || {}) };
  if (!RESPONSES[s.response]) s.response = DEFAULTS.response;
  if (!ACTIONS[s.modeAction]) s.modeAction = DEFAULTS.modeAction;
  if (!ACTIONS[s.gateAction]) s.gateAction = DEFAULTS.gateAction;
  if (!TARGETS[s.modeTarget]) s.modeTarget = DEFAULTS.modeTarget;
  if (!(s.modeMinutes in MODE_LENGTHS)) s.modeMinutes = DEFAULTS.modeMinutes;
  return s;
}
function save(guildId, s) { setGuildConfig(guildId, { raid: { ...DEFAULTS, ...s } }); }
const patch = (guildId, obj) => save(guildId, { ...settings(guildId), ...obj });

const clamp = (v, lo, hi, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };

// ── What counts as a match ────────────────────────────────────────────────────

const isDefaultAvatar = (user) => !user.avatar;
const accountAge = (user) => Date.now() - (user.createdTimestamp || Date.now());

/** Does this joiner match what raid mode is looking for? */
function matchesMode(user, s) {
  const young = accountAge(user) < s.modeYoungDays * DAY, bare = isDefaultAvatar(user);
  return { all: true, young, noavatar: bare, either: young || bare }[s.modeTarget];
}

// ── Doing something about a member ────────────────────────────────────────────

async function actOn(member, action, reason, s) {
  const moderation = require('./moderation');
  const result = await moderation.auto(member.guild, member.user, member, { action, reason, durationMs: action === 'timeout' ? DAY : null, log: false });
  if (result.ok) patch(member.guild.id, { caught: settings(member.guild.id).caught + 1 });
  return result;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

async function alertChannel(guild, s) {
  const id = s.alertChannelId || getLogChannel(guild.id, 'modlog');
  return id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
}

async function alert(guild, s, embed) {
  const channel = await alertChannel(guild, s);
  if (!channel?.isTextBased()) return false;
  const ping = s.pingRoleId && guild.roles.cache.has(s.pingRoleId);
  await channel.send({ content: ping ? `<@&${s.pingRoleId}>` : undefined, embeds: [embed], allowedMentions: ping ? { roles: [s.pingRoleId] } : { parse: [] } })
    .catch(err => log('WARN', 'Raid protection: could not post the alert', { guild: guild.name, err }));
  return true;
}

// ── Raid mode ─────────────────────────────────────────────────────────────────

const isActive = (s) => !!s.active && (s.until === 0 || s.until > Date.now());

function describeMode(s) {
  const who = { all: 'every new member', young: `accounts under ${s.modeYoungDays} day${s.modeYoungDays === 1 ? '' : 's'} old`, noavatar: 'accounts with no profile picture', either: `accounts under ${s.modeYoungDays} day${s.modeYoungDays === 1 ? '' : 's'} old or with no profile picture` }[s.modeTarget];
  return `${ACTIONS[s.modeAction].label} ${who}${s.pauseInvites ? ' and pause invites' : ''}`;
}

/** Turn raid mode on. `by` is a user, or null when the bot started it. */
async function start(guild, by = null, reason = 'Started by staff') {
  let s = settings(guild.id);
  if (isActive(s)) return { ok: true, already: true, s };
  const until = s.modeMinutes ? Date.now() + s.modeMinutes * MINUTE : 0;
  let paused = false, note = '';
  if (s.pauseInvites) {
    try { await guild.disableInvites(true); paused = true; }
    catch (err) { note = /Missing Permissions|50013/i.test(err.message + err.code) ? 'I could not pause invites: I need the Manage Server permission.' : `I could not pause invites: ${err.message}`; }
  }
  save(guild.id, { ...s, active: true, until, startedBy: by?.id || null, startedAt: Date.now(), invitesPausedByUs: paused, raids: s.raids + 1 });
  s = settings(guild.id);
  log('WARN', `Raid mode on in ${guild.name}`, { by: by?.tag || 'automatic', reason });
  require('./memberLog').record(guild.id, by?.id || '0', 'raid', { mode: 'on', reason });
  await alert(guild, s, new EmbedBuilder().setColor(0xED4245).setTitle('🚨 Raid mode is ON')
    .setDescription([`**Why:** ${reason}`, `**What I am doing:** ${describeMode(s)}`, until ? `**Ends:** <t:${Math.floor(until / 1000)}:R>, or sooner with \`/raidmode off\`` : '**Ends:** when staff run `/raidmode off`', paused ? '**Invites:** paused. Nobody new can join with an invite link.' : null, note ? `⚠️ ${note}` : null].filter(Boolean).join('\n')));
  return { ok: true, s, paused, note };
}

/** Turn raid mode off and give invites back (only if raid mode was what paused them). */
async function stop(guild, by = null, why = 'Ended by staff') {
  const s = settings(guild.id);
  if (!s.active) return { ok: true, already: true, s };
  let resumed = false;
  if (s.invitesPausedByUs) { try { await guild.disableInvites(false); resumed = true; } catch (err) { log('WARN', 'Raid protection: could not resume invites', { guild: guild.name, err }); } }
  const lasted = Date.now() - (s.startedAt || Date.now());
  save(guild.id, { ...s, active: false, until: 0, invitesPausedByUs: resumed ? false : s.invitesPausedByUs });
  log('INFO', `Raid mode off in ${guild.name}`, { by: by?.tag || 'automatic', why });
  require('./memberLog').record(guild.id, by?.id || '0', 'raid', { mode: 'off', why });
  await alert(guild, s, new EmbedBuilder().setColor(0x57F287).setTitle('✅ Raid mode is OFF')
    .setDescription([`**Why:** ${why}`, `It was on for ${duration(lasted)} and dealt with **${s.caught}** member${s.caught === 1 ? '' : 's'} in total so far.`, resumed ? 'Invites are back on.' : s.invitesPausedByUs ? '⚠️ I could not turn invites back on. Do it in Server Settings > Invites.' : null].filter(Boolean).join('\n')));
  return { ok: true, resumed };
}

/** Ends raid mode when its time is up. Called every minute and on every join. */
async function expire(guild) {
  const s = settings(guild.id);
  if (s.active && s.until && s.until <= Date.now()) await stop(guild, null, 'The time you set ran out');
}
function startTimer(client) {
  const tick = () => { for (const guild of client.guilds.cache.values()) expire(guild).catch(err => log('WARN', 'Raid protection: expiry check failed', { err })); };
  setInterval(tick, MINUTE).unref?.();
  tick();
}

// ── Joins ─────────────────────────────────────────────────────────────────────

const recent = new Map();   // guild id -> [{ at, id }]
const alertedAt = new Map();

/**
 * Called for every new member before anything else happens. Returns true when the member was removed,
 * so the welcome post and verification are skipped for them.
 */
async function onJoin(member) {
  const { guild, user } = member;
  let s = settings(guild.id);
  if (user.bot || !require('./globalConfig').featureEnabled('raidProtection', guild.id)) return false;   // global switch (/owner)
  if (s.active) await expire(guild), s = settings(guild.id);

  // Detection
  if (s.enabled) {
    const now = Date.now();
    const list = (recent.get(guild.id) || []).filter(j => now - j.at < s.seconds * 1000);
    list.push({ at: now, id: user.id });
    recent.set(guild.id, list);
    if (list.length >= s.joins && !isActive(s) && now - (alertedAt.get(guild.id) || 0) > 10 * MINUTE) {
      alertedAt.set(guild.id, now);
      const why = `${list.length} people joined in ${s.seconds} seconds (your limit is ${s.joins})`;
      if (s.response === 'mode') {
        await start(guild, null, why);
        s = settings(guild.id);
        if (s.sweep) await sweepRecent(guild, list, s);
      } else {
        require('./memberLog').record(guild.id, '0', 'raid', { joins: list.length });
        await alert(guild, s, new EmbedBuilder().setColor(0xED4245).setTitle('🚨 Possible raid')
          .setDescription(`**${why}.**\nRaid mode was not started because you chose to be alerted only. Use \`/raidmode on\` to start it.`));
      }
    }
  }

  // Raid mode
  if (isActive(s) && matchesMode(user, s)) {
    const r = await actOn(member, s.modeAction, 'Raid protection: raid mode is on', s);
    if (r.ok) return true;
    log('WARN', 'Raid protection: could not act on a new member', { guild: guild.name, text: r.text });
  }

  // Account age
  if (s.gateEnabled && accountAge(user) < s.gateDays * DAY) {
    const r = await actOn(member, s.gateAction, `Raid protection: account is only ${age(accountAge(user))} old (the server requires ${s.gateDays} day${s.gateDays === 1 ? '' : 's'})`, s);
    if (r.ok) return true;
  }
  return false;
}

/** When a raid is detected, also deal with the people who just arrived. */
async function sweepRecent(guild, list, s) {
  for (const j of list) {
    const m = guild.members.cache.get(j.id) || await guild.members.fetch(j.id).catch(() => null);
    if (m && !m.user.bot && matchesMode(m.user, s)) await actOn(m, s.modeAction, 'Raid protection: part of a join burst', s);
  }
}

/** Problems that would stop the settings from working, in plain words. */
function diagnose(guild) {
  const s = settings(guild.id), me = guild.members.me, out = [];
  const need = (action) => { const n = ACTIONS[action].needs; if (!me?.permissions.has(n)) out.push(`${ACTIONS[action].label} needs the **${n.replace(/([A-Z])/g, ' $1').trim()}** permission, which I don't have.`); };
  if (s.enabled || s.active) need(s.modeAction);
  if (s.gateEnabled) need(s.gateAction);
  if (s.pauseInvites && s.enabled && !me?.permissions.has('ManageGuild')) out.push('To pause invites I need the **Manage Server** permission. Without it raid mode still works, but invites stay open.');
  return [...new Set(out)];
}

module.exports = { RESPONSES, ACTIONS, TARGETS, MODE_LENGTHS, DEFAULTS, settings, save, patch, clamp, isActive, describeMode, start, stop, expire, startTimer, onJoin, matchesMode, diagnose };
