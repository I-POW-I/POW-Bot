/**
 * Bot presence: the status line shown under the bot's name.
 *
 * Managed by the bot owner from /owner -> Status and stored in data/global-config.json:
 *   presence: { status, rotateSeconds, list: [{ id, type, text }] | null }
 *
 * Placeholders: {servers}  {uptime}  {version}
 * Server-specific details (voice channel names, member counts) are never shown here.
 */

const crypto = require('crypto');
const { ActivityType } = require('discord.js');
const globalConfig = require('./globalConfig');
const { log } = require('./logger');

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

/** Fill in the placeholders. */
function render(text, client) {
  return String(text)
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

module.exports = { TYPES, STATUSES, MAX_ENTRIES, MAX_TEXT, list, isCustomised, settings, render, add, edit, remove, move, setStatus, setRotate, reset, refresh, start };
