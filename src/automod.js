/**
 * AutoMod: message filters that run on every message, plus one-click setup of Discord's own AutoMod rules.
 *
 * Each filter can be switched on separately and has its own response: delete the message, delete it and warn,
 * or delete it and time the member out. Every deleted message is a strike. Enough strikes in a short time and the
 * member is timed out (set in /setup > AutoMod > Strikes). Staff, exempt roles and exempt channels are never touched.
 *
 * Settings live in the server's config under `automod`. Strikes are kept in memory only and forgotten after the window.
 */

const { EmbedBuilder, PermissionFlagsBits: P, AutoModerationRuleEventType: Event, AutoModerationRuleTriggerType: Trigger,
  AutoModerationActionType: Do, AutoModerationRuleKeywordPresetType: Preset } = require('discord.js');
const { getGuildConfig, setGuildConfig, getLogChannel } = require('./guildConfig');
const { log } = require('./logger');

const MINUTE = 60_000;

const RESPONSES = {
  delete:  { label: 'Delete the message',       desc: 'Remove it and tell them why. Counts as a strike' },
  warn:    { label: 'Delete and warn',          desc: 'Also records a warning on their record (/history)' },
  timeout: { label: 'Delete and time out',      desc: 'Also mutes them for the timeout length' },
};
const TIMEOUTS = { 5: '5 minutes', 10: '10 minutes', 60: '1 hour', 1440: '1 day', 10080: '1 week' };

const FILTERS = {
  invites:  { label: 'Invite links',     emoji: '🔗', desc: 'Links to other Discord servers', response: 'delete', fields: [] },
  scam:     { label: 'Scam links',       emoji: '🎣', desc: 'Fake Discord and Steam sites, "free nitro" lures and your own blocked sites', response: 'timeout', fields: [{ id: 'list', label: 'Extra blocked sites (one per line)', list: true, example: 'free-nitro.example' }] },
  links:    { label: 'All links',        emoji: '🌐', desc: 'Every link, except sites you allow', response: 'delete', fields: [{ id: 'list', label: 'Allowed sites (one per line)', list: true, example: 'youtube.com\ntwitch.tv' }] },
  spam:     { label: 'Message spam',     emoji: '💬', desc: 'Too many messages too fast, or the same message again and again', response: 'delete', fields: [{ id: 'count', label: 'Messages allowed…', min: 2, max: 30, def: 5 }, { id: 'seconds', label: '…within this many seconds', min: 2, max: 120, def: 6 }] },
  mentions: { label: 'Mass mentions',    emoji: '📣', desc: 'Too many people or roles mentioned in one message', response: 'timeout', fields: [{ id: 'limit', label: 'Most mentions in one message', min: 2, max: 50, def: 5 }] },
  caps:     { label: 'Capital letters',  emoji: '🔠', desc: 'MESSAGES THAT SHOUT', response: 'delete', fields: [{ id: 'percent', label: 'Percent of letters in capitals', min: 40, max: 100, def: 70 }, { id: 'minLetters', label: 'Ignore messages shorter than (letters)', min: 5, max: 100, def: 12 }] },
  emoji:    { label: 'Emoji spam',       emoji: '😀', desc: 'Messages stuffed with emoji', response: 'delete', fields: [{ id: 'limit', label: 'Most emoji in one message', min: 3, max: 50, def: 10 }] },
  words:    { label: 'Blocked words',    emoji: '🚫', desc: 'Words and phrases you choose', response: 'delete', fields: [{ id: 'list', label: 'Blocked words (one per line, * is a wildcard)', list: true, example: 'badword\nsome*phrase' }] },
};

const DEFAULTS = {
  enabled: false, logChannelId: null, exemptRoleIds: [], exemptChannelIds: [], notice: true, timeout: 10,
  strikes: 3, strikeMinutes: 10, strikeTimeout: 60, caught: 0, filters: {},
};

function settings(guildId) {
  const s = { ...DEFAULTS, ...(getGuildConfig(guildId).automod || {}) };
  s.exemptRoleIds = Array.isArray(s.exemptRoleIds) ? s.exemptRoleIds : [];
  s.exemptChannelIds = Array.isArray(s.exemptChannelIds) ? s.exemptChannelIds : [];
  if (!(s.timeout in TIMEOUTS)) s.timeout = DEFAULTS.timeout;
  if (!(s.strikeTimeout in TIMEOUTS)) s.strikeTimeout = DEFAULTS.strikeTimeout;
  s.filters = Object.fromEntries(Object.entries(FILTERS).map(([key, f]) => [key, filterOf(s.filters?.[key], f)]));
  return s;
}
function filterOf(saved = {}, meta) {
  const o = { on: !!saved.on, response: RESPONSES[saved.response] ? saved.response : meta.response };
  for (const f of meta.fields) o[f.id] = f.list ? (Array.isArray(saved[f.id]) ? saved[f.id] : []) : (Number.isFinite(saved[f.id]) ? saved[f.id] : f.def);
  return o;
}
function save(guildId, s) { setGuildConfig(guildId, { automod: { ...DEFAULTS, ...s } }); }
const patch = (guildId, obj) => save(guildId, { ...settings(guildId), ...obj });
function patchFilter(guildId, key, obj) { const s = settings(guildId); save(guildId, { ...s, filters: { ...s.filters, [key]: { ...s.filters[key], ...obj } } }); }

/** One line for the setup screens: "on · delete the message · 5 per 6s". */
function filterSummary(f, key) {
  if (!f.on) return 'off';
  const bits = [RESPONSES[f.response].label.toLowerCase()];
  if (key === 'spam') bits.push(`${f.count} per ${f.seconds}s`);
  if (key === 'mentions' || key === 'emoji') bits.push(`over ${f.limit}`);
  if (key === 'caps') bits.push(`over ${f.percent}%`);
  if (['links', 'scam', 'words'].includes(key)) bits.push(`${f.list.length} ${key === 'links' ? 'allowed' : key === 'scam' ? 'extra' : 'listed'}`);
  return bits.join(' · ');
}

// ── Detection ─────────────────────────────────────────────────────────────────

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>()]+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|gift|xyz|ru|tk|ml|ga|cf|top|club|info|co|me|app|link|click|live|site|online|store|shop|cc|ws|to)(?:\/[^\s<>()]*)?)/gi;
const INVITE_RE = /(?:discord(?:app)?\.(?:gg|com\/invite|me|io|li)|dsc\.gg|invite\.gg)\/[a-z0-9-]+/i;

const hostOf = (raw) => { try { return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
const links = (text) => [...String(text).matchAll(URL_RE)].map(m => hostOf(m[0])).filter(Boolean);
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

const OFFICIAL = {
  discord: ['discord.com', 'discord.gg', 'discord.gift', 'discordapp.com', 'discordapp.net', 'discord.new', 'discord.media', 'discordstatus.com', 'discord.dev', 'discord.design', 'discord.store', 'discord.co', 'discordbotlist.com', 'discordservers.com', 'discord.bots.gg'],
  steam:   ['steampowered.com', 'steamcommunity.com', 'steamgames.com', 'steamstatic.com', 'steamusercontent.com', 'steam.com', 'valvesoftware.com', 'steamdb.info', 'steamgifts.com', 'steamcharts.com', 'steamladder.com', 'steamrep.com'],
};
const LURE_RE = /\b(free\s+nitro|nitro\s+(?:gift|giveaway|for\s+free)|claim\s+(?:your\s+)?(?:gift|nitro|reward)|steam\s+gift|airdrop|gifted\s+you\s+nitro)\b/i;

/** Is this link a fake Discord or Steam site, or on the server's own blocked list? Returns the reason or null. */
function scamReason(text, extra = []) {
  const hosts = links(text);
  for (const h of hosts) {
    if (extra.some(d => onDomain(h, d.toLowerCase()))) return `blocked site (${h})`;
    for (const [brand, ok] of Object.entries(OFFICIAL)) {
      const squashed = h.replace(/[^a-z0-9]/g, '').replace(/0/g, 'o').replace(/cl/g, 'd').replace(/1|l(?=[a-z])/g, 'i');
      if ((squashed.includes(brand) || h.includes(brand)) && !ok.some(d => onDomain(h, d))) return `fake ${brand[0].toUpperCase() + brand.slice(1)} site (${h})`;
    }
  }
  if (hosts.length && LURE_RE.test(text)) return 'a "free gift" lure with a link';
  return null;
}

const wildcard = (word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\n]*?')}(?![\\p{L}\\p{N}])`, 'iu');

const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;

const recentMessages = new Map();   // guild:user -> [{ at, text }]

/** Which filter does this message break? Returns { key, reason } or null. */
function check(message, s, edited = false) {
  const text = message.content || '';
  const F = s.filters;
  if (F.invites.on && INVITE_RE.test(text)) return { key: 'invites', reason: 'Posted a Discord invite link' };
  if (F.scam.on) { const r = scamReason(text, F.scam.list); if (r) return { key: 'scam', reason: `Posted a scam link: ${r}` }; }
  if (F.links.on) {
    const bad = links(text).find(h => !F.links.list.some(d => onDomain(h, d.toLowerCase().replace(/^www\./, ''))));
    if (bad) return { key: 'links', reason: `Posted a link that is not allowed (${bad})` };
  }
  if (F.words.on && F.words.list.length) {
    const hit = F.words.list.find(w => w.trim() && wildcard(w).test(text));
    if (hit) return { key: 'words', reason: 'Used a blocked word' };
  }
  if (F.mentions.on) {
    const n = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    if (n > F.mentions.limit) return { key: 'mentions', reason: `Mentioned ${n} people or roles in one message (limit ${F.mentions.limit})` };
  }
  if (F.emoji.on) {
    const n = (text.match(EMOJI_RE) || []).length;
    if (n > F.emoji.limit) return { key: 'emoji', reason: `Used ${n} emoji in one message (limit ${F.emoji.limit})` };
  }
  if (F.caps.on) {
    const letters = text.replace(/<[^>]+>|https?:\/\/\S+|[^\p{L}]/gu, '');
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
    if (letters.length >= F.caps.minLetters && upper / letters.length * 100 >= F.caps.percent) return { key: 'caps', reason: `Over ${F.caps.percent}% of the message was in capitals` };
  }
  if (F.spam.on && !edited) {
    const k = `${message.guild.id}:${message.author.id}`, now = Date.now();
    const list = (recentMessages.get(k) || []).filter(m => now - m.at < Math.max(F.spam.seconds, 30) * 1000);
    list.push({ at: now, text: text.trim().toLowerCase() });
    recentMessages.set(k, list);
    const burst = list.filter(m => now - m.at < F.spam.seconds * 1000).length;
    const same = text.trim() ? list.filter(m => m.text === text.trim().toLowerCase()).length : 0;
    if (burst > F.spam.count) return { key: 'spam', reason: `Sent ${burst} messages in ${F.spam.seconds} seconds (limit ${F.spam.count})` };
    if (same >= 4) return { key: 'spam', reason: 'Sent the same message again and again' };
  }
  return null;
}

// ── Who is never touched ──────────────────────────────────────────────────────

const STAFF_PERMS = [P.Administrator, P.ManageGuild, P.ManageMessages, P.ManageChannels, P.KickMembers, P.BanMembers, P.ModerateMembers];
function isExempt(member, channelId, s) {
  if (s.exemptChannelIds.includes(channelId)) return true;
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (STAFF_PERMS.some(p => member.permissions.has(p))) return true;
  return s.exemptRoleIds.some(id => member.roles.cache.has(id));
}

// ── Acting ────────────────────────────────────────────────────────────────────

const strikeLog = new Map();   // guild:user -> [timestamps]
const busy = new Set();

async function logTo(guild, s, embed) {
  const id = s.logChannelId || getLogChannel(guild.id, 'modlog');
  const channel = id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
  if (channel?.isTextBased()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(err => log('WARN', 'AutoMod: could not write the log', { guild: guild.name, err }));
}

function logEntry(message, hit, taken) {
  return new EmbedBuilder().setColor(0xFAA61A).setTitle(`AutoMod · ${FILTERS[hit.key].label}`)
    .setDescription(`${message.author} in ${message.channel}\n**${hit.reason}**`)
    .addFields({ name: 'Message', value: (message.content || '*no text*').slice(0, 900).replace(/`/g, '​`') || '*no text*' }, { name: 'What I did', value: taken.join('\n') || 'Deleted the message.' })
    .setFooter({ text: `ID ${message.author.id}` }).setTimestamp();
}

async function handleMessage(message, { edited = false } = {}) {
  const guild = message.guild;
  if (!guild || !message.author || message.author.bot || message.webhookId || message.system || !message.content) return;
  const s = settings(guild.id);
  if (!s.enabled || !Object.values(s.filters).some(f => f.on)) return;
  const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
  if (isExempt(member, message.channelId, s)) return;

  const hit = check(message, s, edited);
  if (!hit) return;
  const key = `${guild.id}:${message.author.id}`;
  const f = s.filters[hit.key];
  const moderation = require('./moderation');
  const taken = [];

  if (busy.has(message.id)) return;
  busy.add(message.id);
  try {
    if (await message.delete().then(() => true).catch(() => false)) taken.push('Deleted the message.');
    patch(guild.id, { caught: s.caught + 1 });

    // Strikes
    const now = Date.now();
    const strikes = (strikeLog.get(key) || []).filter(t => now - t < s.strikeMinutes * MINUTE);
    strikes.push(now); strikeLog.set(key, strikes);

    let r = null;
    const reason = `AutoMod: ${hit.reason}`;
    if (s.strikes && strikes.length >= s.strikes) {
      strikeLog.delete(key);
      r = await moderation.auto(guild, message.author, member, { action: 'timeout', durationMs: s.strikeTimeout * MINUTE, reason: `AutoMod: ${strikes.length} strikes in ${s.strikeMinutes} minutes (last: ${hit.reason})` });
      if (r.ok) taken.push(`${strikes.length} strikes in ${s.strikeMinutes} minutes: timed out for ${TIMEOUTS[s.strikeTimeout]}. ${r.text}.`);
    } else if (f.response === 'timeout') {
      r = await moderation.auto(guild, message.author, member, { action: 'timeout', durationMs: s.timeout * MINUTE, reason });
      if (r.ok) taken.push(`Timed out for ${TIMEOUTS[s.timeout]}. ${r.text}.`);
    } else if (f.response === 'warn') {
      r = await moderation.auto(guild, message.author, member, { action: 'warn', reason });
      if (r.ok) taken.push(`Warned. ${r.text}.`);
    }
    if (r && !r.ok) taken.push(`⚠️ ${r.text}`);

    // A short notice in the channel, removed after a few seconds
    if (s.notice && !(r?.ok && r.dmSent)) {
      const channel = message.channel;
      channel.send({ content: `${message.author}, ${NOTICE[hit.key]}`, allowedMentions: { users: [message.author.id] } })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 8000).unref?.()).catch(() => {});
    }
    await logTo(guild, s, logEntry(message, hit, taken));
  } catch (err) {
    log('WARN', 'AutoMod failed', { guild: guild.name, err });
  } finally {
    setTimeout(() => busy.delete(message.id), 10_000).unref?.();
  }
}

const NOTICE = {
  invites: 'invite links are not allowed here.', scam: 'that link looks like a scam and was removed.', links: 'links are not allowed here.',
  spam: 'slow down, you are sending messages too fast.', mentions: 'please do not mass mention people.', caps: 'please do not shout.',
  emoji: 'please do not spam emoji.', words: 'that message went against the server rules.',
};

// ── Discord's built-in AutoMod ────────────────────────────────────────────────

const NATIVE = {
  keywords: { label: 'Profanity, sexual content and slurs', name: 'POW-Bot · Bad language' },
  mentions: { label: 'Mass mention spam',                   name: 'POW-Bot · Mention spam' },
  spam:     { label: 'Spam and suspected scam content',     name: 'POW-Bot · Spam' },
  scam:     { label: 'Free nitro and gift scams',           name: 'POW-Bot · Scam lures' },
};

function nativeRule(kind, guild, s) {
  const alert = s.logChannelId || getLogChannel(guild.id, 'modlog');
  const actions = [{ type: Do.BlockMessage, metadata: { customMessage: 'This message was blocked by the server\'s AutoMod.' } }];
  if (alert) actions.push({ type: Do.SendAlertMessage, metadata: { channel: alert } });
  const base = { name: NATIVE[kind].name, eventType: Event.MessageSend, actions, enabled: true, exemptRoles: s.exemptRoleIds.slice(0, 20), exemptChannels: s.exemptChannelIds.slice(0, 50), reason: 'POW-Bot: AutoMod setup' };
  if (kind === 'keywords') return { ...base, triggerType: Trigger.KeywordPreset, triggerMetadata: { presets: [Preset.Profanity, Preset.SexualContent, Preset.Slurs] } };
  if (kind === 'mentions') return { ...base, triggerType: Trigger.MentionSpam, triggerMetadata: { mentionTotalLimit: 10 } };
  if (kind === 'spam')     return { ...base, triggerType: Trigger.Spam };
  return { ...base, triggerType: Trigger.Keyword, triggerMetadata: { keywordFilter: ['*free nitro*', '*nitro giveaway*', '*steam gift*', '*claim your gift*', '*discord.gift/*'] } };
}

/** Create (or replace) one of Discord's own rules. Returns { ok, text }. */
async function createNative(guild, kind) {
  const s = settings(guild.id);
  if (!NATIVE[kind]) return { ok: false, text: 'Unknown rule.' };
  try {
    const existing = await guild.autoModerationRules.fetch();
    const old = existing.find(r => r.name === NATIVE[kind].name);
    if (old) await old.delete('POW-Bot: replaced').catch(() => {});
    await guild.autoModerationRules.create(nativeRule(kind, guild, s));
    return { ok: true, text: `Added Discord's built-in rule: ${NATIVE[kind].label}.` };
  } catch (err) {
    const perms = /Missing Permissions|50013|Missing Access/i.test(err.message + err.code);
    return { ok: false, text: perms ? 'I need the **Manage Server** permission to add Discord\'s AutoMod rules. Give it to me for a moment, or add the rule yourself in Server Settings > AutoMod.' : `Discord would not add it: ${err.message}` };
  }
}

async function nativeStatus(guild) {
  try {
    const rules = await guild.autoModerationRules.fetch();
    return Object.fromEntries(Object.entries(NATIVE).map(([k, v]) => [k, rules.some(r => r.name === v.name && r.enabled)]));
  } catch { return null; }
}

function diagnose(guild) {
  const s = settings(guild.id), me = guild.members.me, out = [];
  if (!s.enabled) return out;
  if (!me?.permissions.has('ManageMessages')) out.push('I need the **Manage Messages** permission to delete messages.');
  const needsTimeout = Object.values(s.filters).some(f => f.on && f.response === 'timeout') || s.strikes;
  if (needsTimeout && !me?.permissions.has('ModerateMembers')) out.push('Timeouts need the **Timeout Members** permission, which I don\'t have.');
  return out;
}

module.exports = { RESPONSES, TIMEOUTS, FILTERS, NATIVE, DEFAULTS, settings, save, patch, patchFilter, filterSummary, check, scamReason, links, isExempt, handleMessage, createNative, nativeStatus, diagnose };
