/**
 * Voice leaderboard and role rewards.
 *
 * Voice time comes from vc_sessions (src/database.js). Time in the server's AFK channel is not counted.
 * Settings live in the server config (src/guildConfig.js) under `leaderboard`:
 *   { rewards: boolean, autoRoles: boolean, tiers: [{ hours, name, roleId }],
 *     post: { frequency: 'off' | 'weekly' | 'monthly', channelId, lastKey } }
 *
 * Rewards work as a ladder: a member holds the role of the highest tier they have reached,
 * and lower tier roles managed here are removed when they move up.
 */

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const { selectAll, selectOne } = require('./database');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { log } = require('./logger');

const HOUR = 3_600_000, DAY = 86_400_000;
const PERIODS = {
  all:   { label: 'All time',     ms: null },
  week:  { label: 'Last 7 days',  ms: 7 * DAY },
  month: { label: 'Last 30 days', ms: 30 * DAY },
};
const PRESETS = {
  standard:  { label: 'Standard',  hours: [5, 25, 100, 250, 500] },
  casual:    { label: 'Casual',    hours: [2, 10, 40, 100] },
  dedicated: { label: 'Dedicated', hours: [10, 50, 200, 500, 1000] },
};
const MAX_TIERS = 8, MAX_HOURS = 10_000, TOP = 10, SCAN = 50;
const BLUE = 0x5865F2;
const MEDALS = ['🥇', '🥈', '🥉'];

// ── Settings ──────────────────────────────────────────────────────────────────

const FREQUENCIES = { weekly: { label: 'Weekly', period: 'week' }, monthly: { label: 'Monthly', period: 'month' } };

function settings(guildId) {
  const s = getGuildConfig(guildId).leaderboard || {};
  const p = s.post || {};
  return {
    rewards: !!s.rewards, autoRoles: s.autoRoles !== false, tiers: Array.isArray(s.tiers) ? s.tiers : [],
    post: { frequency: FREQUENCIES[p.frequency] ? p.frequency : 'off', channelId: p.channelId || null, lastKey: p.lastKey || null },
  };
}
const save = (guildId, s) => setGuildConfig(guildId, { leaderboard: { rewards: !!s.rewards, autoRoles: s.autoRoles !== false, tiers: s.tiers, post: s.post } });

const defaultName = (hours) => `Voice ${hours}h`;
const sortTiers = (tiers) => [...tiers].sort((a, b) => a.hours - b.hours);

/** Build a ladder from hour values, keeping roles already linked to the same hours. */
function ladder(guildId, entries) {
  const old = settings(guildId).tiers;
  return sortTiers(entries.map(e => ({ hours: e.hours, name: e.name || defaultName(e.hours), roleId: old.find(t => t.hours === e.hours)?.roleId || null })));
}

const presetLadder = (guildId, key) => ladder(guildId, PRESETS[key].hours.map(hours => ({ hours })));

/**
 * Custom ladder from text. One tier per line: "hours" or "hours name". A single line of
 * numbers separated by commas ("5, 25, 100") also works.
 */
function parseLadder(guildId, text) {
  let lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 1 && /^[\d\s,]+$/.test(lines[0])) lines = lines[0].split(',').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'Enter at least one tier.' };
  if (lines.length > MAX_TIERS) return { ok: false, error: `Use at most ${MAX_TIERS} tiers.` };
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s*(?:h|hours?)?\s*(.*)$/i);
    const hours = m ? Number(m[1]) : NaN;
    if (!m || !hours || hours > MAX_HOURS) return { ok: false, error: `"${line.slice(0, 40)}" doesn't start with a number of hours between 1 and ${MAX_HOURS}.` };
    const name = m[2].trim().slice(0, 40);
    if (entries.some(e => e.hours === hours)) return { ok: false, error: `${hours} hours is listed twice.` };
    entries.push({ hours, name });
  }
  return { ok: true, tiers: ladder(guildId, entries) };
}

// ── Voice time ────────────────────────────────────────────────────────────────

const afkOf = (guild) => guild.afkChannelId || '';

/** Voice time per member, highest first. Sessions still running count up to now. */
function totals(guild, period = 'all', limit = SCAN) {
  const now = Date.now(), since = PERIODS[period]?.ms ? now - PERIODS[period].ms : 0;
  return selectAll(
    'SELECT user_id, SUM(COALESCE(duration_ms, ? - joined_at)) AS ms FROM vc_sessions WHERE guild_id = ? AND channel_id != ? AND joined_at >= ? GROUP BY user_id ORDER BY ms DESC LIMIT ?',
    [now, guild.id, afkOf(guild), since, limit]);
}

function totalFor(guild, userId, period = 'all') {
  const now = Date.now(), since = PERIODS[period]?.ms ? now - PERIODS[period].ms : 0;
  const row = selectOne(
    'SELECT SUM(COALESCE(duration_ms, ? - joined_at)) AS ms FROM vc_sessions WHERE guild_id = ? AND user_id = ? AND channel_id != ? AND joined_at >= ?',
    [now, guild.id, userId, afkOf(guild), since]);
  return Number(row?.ms || 0);
}

function duration(ms) {
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60);
  return h > 0 ? `${h.toLocaleString('en-GB')}h ${m % 60}m` : `${m}m`;
}

/** The ranking, limited to people still in the server (and not bots). */
async function board(guild, period) {
  const rows = totals(guild, period);
  if (!rows.length) return [];
  let present;
  try { present = await guild.members.fetch({ user: rows.map(r => r.user_id), limit: SCAN }); }
  catch { present = guild.members.cache; }
  return rows.filter(r => present.get(r.user_id) && !present.get(r.user_id).user.bot).map(r => ({ id: r.user_id, ms: Number(r.ms) }));
}

// ── The leaderboard message ───────────────────────────────────────────────────

async function view(guild, period = 'all', viewerId = null) {
  if (!PERIODS[period]) period = 'all';
  const ranking = await board(guild, period);
  const lines = ranking.slice(0, TOP).map((r, i) => `${MEDALS[i] || `**${i + 1}.**`} <@${r.id}> · ${duration(r.ms)}`);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`🏆 Voice leaderboard: ${guild.name}`)
    .setDescription(lines.length ? lines.join('\n') : 'No voice time recorded yet. Join a voice channel to get on the board.')
    .setFooter({ text: `${PERIODS[period].label} · the AFK channel is not counted` });
  if (viewerId) {
    const at = ranking.findIndex(r => r.id === viewerId);
    embed.addFields({ name: 'Your position', value: at >= 0 ? `#${at + 1} · ${duration(ranking[at].ms)}` : totalFor(guild, viewerId, period) > 0 ? `Outside the top ${SCAN} · ${duration(totalFor(guild, viewerId, period))}` : 'No voice time in this period', inline: false });
  }
  const select = new StringSelectMenuBuilder().setCustomId('lb:period').setPlaceholder('Time period')
    .addOptions(Object.entries(PERIODS).map(([value, p]) => ({ label: p.label, value, default: value === period })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// ── Scheduled post ────────────────────────────────────────────────────────────

const POST_HOUR_UTC = 9;

/** Identifies the current week (Monday start) or month, so each is posted once. */
function periodKey(frequency, date = new Date()) {
  if (frequency === 'monthly') return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

/** Turn the scheduled post on (or off). The first post goes out at the start of the next week or month. */
function setPost(guildId, frequency, channelId) {
  const s = settings(guildId);
  const on = !!FREQUENCIES[frequency];
  s.post = { frequency: on ? frequency : 'off', channelId: channelId || s.post.channelId, lastKey: on ? periodKey(frequency) : null };
  save(guildId, s);
  return s;
}

/** The weekly or monthly leaderboard message. */
async function postView(guild, frequency) {
  const { label, period } = FREQUENCIES[frequency];
  const ranking = (await board(guild, period)).slice(0, TOP);
  const lines = ranking.map((r, i) => `${MEDALS[i] || `**${i + 1}.**`} <@${r.id}> · ${duration(r.ms)}`);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`🏆 ${label} voice leaderboard`)
      .setDescription(lines.length ? lines.join('\n') : 'Nobody spent time in voice this period.')
      .setFooter({ text: `${PERIODS[period].label} · the AFK channel is not counted` })],
    allowedMentions: { parse: [] },
  };
}

/** Post the leaderboard in every server whose schedule is due. Checked hourly. */
async function postDue(client, now = new Date()) {
  if (now.getUTCHours() < POST_HOUR_UTC) return 0;
  let sent = 0;
  for (const guild of client.guilds.cache.values()) {
    const s = settings(guild.id), { frequency, channelId, lastKey } = s.post;
    if (frequency === 'off' || !channelId) continue;
    const key = periodKey(frequency, now);
    if (key === lastKey) continue;
    s.post.lastKey = key; save(guild.id, s);   // mark first: a failed post is not retried every hour
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) { log('WARN', 'Scheduled leaderboard channel is gone', { guild: guild.name }); continue; }
      await channel.send(await postView(guild, frequency));
      sent++;
    } catch (err) { log('WARN', 'Could not post the scheduled leaderboard', { guild: guild.name, err }); }
  }
  return sent;
}

// ── Roles ─────────────────────────────────────────────────────────────────────

const canManageRoles = (guild) => !!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles);

/** Create any tier role that doesn't exist yet. Returns the names created and any problem. */
async function ensureRoles(guild, s = settings(guild.id)) {
  if (!canManageRoles(guild)) return { created: [], error: 'I need the **Manage Roles** permission to create the roles.' };
  const created = [];
  for (const tier of s.tiers) {
    if (tier.roleId && guild.roles.cache.has(tier.roleId)) continue;
    try {
      const role = await guild.roles.create({ name: tier.name || defaultName(tier.hours), mentionable: false, permissions: [], reason: `POW-Bot voice reward (${tier.hours}h)` });
      tier.roleId = role.id; created.push(role.name);
    } catch (err) {
      save(guild.id, s);
      return { created, error: `I couldn't create **${tier.name}**: ${err.message}` };
    }
  }
  save(guild.id, s);
  return { created };
}

/** Tiers whose role is missing or above the bot's own role. */
function roleProblems(guild, s = settings(guild.id)) {
  return s.tiers.flatMap(t => {
    const role = t.roleId && guild.roles.cache.get(t.roleId);
    if (!role) return [`**${t.hours}h**: no role set`];
    if (!role.editable) return [`**${t.hours}h**: ${role} is above my highest role`];
    return [];
  });
}

/** Give a member the role for the highest tier they have reached (and take away lower ones). */
async function syncMember(guild, member, s = settings(guild.id)) {
  if (!s.rewards || !s.tiers.length || !member || member.user.bot || !canManageRoles(guild)) return false;
  const hours = totalFor(guild, member.id) / HOUR;
  const target = sortTiers(s.tiers).filter(t => t.roleId && hours >= t.hours).pop() || null;
  const usable = (id) => { const r = guild.roles.cache.get(id); return r && r.editable; };
  const add = target && !member.roles.cache.has(target.roleId) && usable(target.roleId) ? [target.roleId] : [];
  const remove = s.tiers.map(t => t.roleId).filter(id => id && id !== target?.roleId && member.roles.cache.has(id) && usable(id));
  try {
    if (add.length) await member.roles.add(add, 'Voice reward');
    if (remove.length) await member.roles.remove(remove, 'Voice reward ladder');
  } catch (err) {
    log('WARN', 'Could not update a voice reward role', { guild: guild.name, err });
    return false;
  }
  return add.length > 0 || remove.length > 0;
}

/** Check everyone with enough voice time. Slow on purpose, to stay inside Discord's rate limits. */
async function syncAll(guild) {
  const s = settings(guild.id);
  if (!s.rewards || !s.tiers.length) return { checked: 0, changed: 0 };
  const min = Math.min(...s.tiers.map(t => t.hours)) * HOUR;
  const rows = totals(guild, 'all', 500).filter(r => Number(r.ms) >= min);
  let changed = 0;
  for (const r of rows) {
    const member = await guild.members.fetch(r.user_id).catch(() => null);
    if (member && await syncMember(guild, member, s)) changed++;
    await new Promise(res => setTimeout(res, 300));
  }
  return { checked: rows.length, changed };
}

/** Called when someone leaves voice. */
function onVoiceLeave(guild, member) {
  const s = settings(guild.id);
  if (s.rewards) syncMember(guild, member, s).catch(() => {});
}

/** People who stay in voice for hours are checked every 15 minutes. */
function start(client) {
  const posts = setInterval(() => postDue(client).catch(err => log('WARN', 'Scheduled leaderboard check failed', { err })), 3_600_000);
  posts.unref?.();
  const timer = setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const s = settings(guild.id);
      if (!s.rewards) continue;
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId && state.member && !state.member.user.bot) await syncMember(guild, state.member, s).catch(() => {});
      }
    }
  }, 15 * 60_000);
  timer.unref?.();
}

module.exports = {
  PERIODS, PRESETS, FREQUENCIES, MAX_TIERS, settings, setPost, periodKey, postView, postDue, save, ladder, presetLadder, parseLadder, defaultName, sortTiers,
  totalFor, duration, view, ensureRoles, roleProblems, syncMember, syncAll, onVoiceLeave, start, canManageRoles,
};
