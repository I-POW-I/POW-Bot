/**
 * Bot presence: the status line shown under the bot's name.
 *
 * Managed by the bot owner from /owner -> Status and stored in data/global-config.json:
 *   presence: { status, rotateSeconds, list: [{ id, type, text }] | null }
 *
 * Placeholders:
 *   {servers}     servers the bot is in           {members}   total members across them ({users} works too)
 *   {voicehours}  hours spent in voice, all servers   {voicenow}  people in voice right now
 *   {uptime}      time since the bot started          {version}   bot version
 * Totals only: nothing that identifies a server, channel or member is ever shown.
 */

const crypto = require('crypto');
const { ActivityType } = require('discord.js');
const globalConfig = require('./globalConfig');
const { log } = require('./logger');
const { selectOne } = require('./database');

const TYPES = {
  playing:   { label: 'Playing',   type: ActivityType.Playing },
  watching:  { label: 'Watching',  type: ActivityType.Watching },
  listening: { label: 'Listening to', type: ActivityType.Listening },
  competing: { label: 'Competing in', type: ActivityType.Competing },
  custom:    { label: 'Custom',    type: ActivityType.Custom },
};
const STATUSES = ['online', 'idle', 'dnd'];
const MAX_ENTRIES = 10;
const MAX_TEXT = 100;
const MIN_ROTATE = 15, MAX_ROTATE = 600;

const DEFAULT_LIST = [
  { id: 'default1', type: 'custom',   text: 'Online 24/7' },
  { id: 'default2', type: 'watching', text: '{servers} servers' },
];

/** Ready-made statuses the owner can add with one click. */
const TEMPLATES = [
  { label: 'Servers',                type: 'watching', text: '{servers} servers' },
  { label: 'Members',                type: 'watching', text: '{members} members' },
  { label: 'Servers and members',    type: 'watching', text: '{servers} servers · {members} members' },
  { label: 'Hours in voice',         type: 'custom',   text: '{voicehours} hours in voice' },
  { label: 'In voice right now',     type: 'custom',   text: '{voicenow} in voice right now' },
  { label: 'Uptime',                 type: 'custom',   text: 'Online for {uptime}' },
  { label: 'Version',                type: 'custom',   text: 'POW-Bot {version}' },
  { label: 'Online 24/7',            type: 'custom',   text: 'Online 24/7' },
  { label: 'Point to /help',         type: 'custom',   text: 'Use /help to get started' },
];

const cfg = () => globalConfig.get().presence;

/** The statuses in use (the built-in pair until the owner customises the list). */
function list() {
  const l = cfg().list;
  return Array.isArray(l) && l.length ? l : DEFAULT_LIST;
}
const isCustomised = () => Array.isArray(cfg().list);
const settings = () => ({ status: STATUSES.includes(cfg().status) ? cfg().status : 'dnd', rotateSeconds: clampRotate(cfg().rotateSeconds) });

const clampRotate = (n) => Math.min(MAX_ROTATE, Math.max(MIN_ROTATE, Math.round(Number(n)) || 30));

function uptimeText() {
  const s = Math.floor(process.uptime()), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

let hoursCache = { at: 0, value: 0 };
/** Total hours spent in voice across every server (looked up at most once a minute). */
function voiceHours() {
  if (Date.now() - hoursCache.at > 60_000) {
    try { hoursCache = { at: Date.now(), value: Math.floor(Number(selectOne('SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM vc_sessions WHERE duration_ms IS NOT NULL')?.ms || 0) / 3_600_000) }; }
    catch { hoursCache.at = Date.now(); }
  }
  return hoursCache.value;
}

const number = (n) => Number(n || 0).toLocaleString('en-GB');
const totalMembers = (client) => (client?.guilds?.cache ? [...client.guilds.cache.values()].reduce((a, g) => a + (g.memberCount || 0), 0) : 0);
const inVoiceNow = (client) => (client?.guilds?.cache ? [...client.guilds.cache.values()].reduce((a, g) => a + (g.voiceStates?.cache ? g.voiceStates.cache.filter(v => v.channelId && !v.member?.user?.bot).size : 0), 0) : 0);

/** Fill in the placeholders. */
function render(text, client) {
  return String(text)
    .replace(/\{members\}|\{users\}/gi, () => number(totalMembers(client)))
    .replace(/\{voicehours\}/gi, () => number(voiceHours()))
    .replace(/\{voicenow\}/gi, () => number(inVoiceNow(client)))
    .replace(/\{servers\}/gi, String(client?.guilds?.cache?.size ?? 0))
    .replace(/\{uptime\}/gi, uptimeText())
    .replace(/\{version\}/gi, `v${require('../package.json').version}`);
}

// ── Editing (used by /owner) ──────────────────────────────────────────────────

function cleanText(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }

/** Make the list editable: the first change copies the built-in statuses so they can be edited too. */
function mutate(fn) {
  globalConfig.update(s => {
    if (!Array.isArray(s.presence.list)) s.presence.list = DEFAULT_LIST.map(e => ({ ...e }));
    fn(s.presence);
  });
}

function add(type, text) {
  type = TYPES[type] ? type : 'custom'; text = cleanText(text);
  if (!text) return { ok: false, error: 'The status text is empty.' };
  if (list().length >= MAX_ENTRIES && isCustomised()) return { ok: false, error: `You can have up to ${MAX_ENTRIES} statuses.` };
  const entry = { id: crypto.randomBytes(3).toString('hex'), type, text };
  mutate(p => p.list.push(entry));
  return { ok: true, entry };
}

function edit(id, type, text) {
  text = cleanText(text);
  if (!text) return { ok: false, error: 'The status text is empty.' };
  let found = false;
  mutate(p => { const e = p.list.find(x => x.id === id); if (e) { found = true; e.type = TYPES[type] ? type : e.type; e.text = text; } });
  return found ? { ok: true } : { ok: false, error: 'That status no longer exists.' };
}

function remove(id) {
  let found = false;
  mutate(p => { const i = p.list.findIndex(x => x.id === id); if (i >= 0) { p.list.splice(i, 1); found = true; } });
  return found ? { ok: true } : { ok: false, error: 'That status no longer exists.' };
}

function move(id, direction) {
  mutate(p => {
    const i = p.list.findIndex(x => x.id === id), j = i + (direction < 0 ? -1 : 1);
    if (i >= 0 && j >= 0 && j < p.list.length) [p.list[i], p.list[j]] = [p.list[j], p.list[i]];
  });
}

function setStatus(status) { if (STATUSES.includes(status)) globalConfig.update(s => { s.presence.status = status; }); }
function setRotate(seconds)  { globalConfig.update(s => { s.presence.rotateSeconds = clampRotate(seconds); }); }
function reset() { globalConfig.update(s => { s.presence = { status: 'dnd', rotateSeconds: 30, list: null }; }); }

// ── Running it ────────────────────────────────────────────────────────────────

let index = 0, timer = null, lastClient = null;

/** Apply the next status now. Safe to call at any time. */
function apply(client, { advance = true } = {}) {
  try {
    if (!client?.user) return;
    const l = list();
    if (advance) index = (index + 1) % l.length; else index = index % l.length;
    const entry = l[index];
    client.user.setPresence({
      status: settings().status,
      activities: [{ name: render(entry.text, client), type: TYPES[entry.type]?.type ?? ActivityType.Custom }],
    });
  } catch (err) {
    log('WARN', 'Could not update the bot status', { err });
  }
}

function schedule(client) {
  clearTimeout(timer);
  timer = setTimeout(() => { apply(client); schedule(client); }, settings().rotateSeconds * 1000);
  timer.unref?.();
}

/** Show the current status straight away (after the owner edits the list, or the bot joins/leaves a channel). */
function refresh(client = lastClient) {
  if (!client) return;
  index = -1; apply(client); schedule(client);
}

function start(client) {
  lastClient = client;
  index = -1;
  apply(client);
  schedule(client);
  log('INFO', `Status rotation started (${list().length} status(es), every ${settings().rotateSeconds}s)`);
}

module.exports = { TEMPLATES, TYPES, STATUSES, MAX_ENTRIES, MAX_TEXT, list, isCustomised, settings, render, add, edit, remove, move, setStatus, setRotate, reset, refresh, start };
