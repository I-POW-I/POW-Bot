/**
 * Bot-wide settings (not per server) — stored in data/global-config.json
 *
 * {
 *   maintenance: { enabled, message, since, by },
 *   features:    { streamerAlerts, gameAlerts },        // global kill switches (default on)
 *   blacklist:   { users: { id: {reason, at, by} }, guilds: { id: {reason, at, by} } },
 *   audit:       [ { at, action, actor, guild, details } ],   // last 200 changes
 *   alerts:      { webhookUrl, webhookId, dm, levels, digestMinutes, memoryPercent },   // set by /owner alerts → Set up (Discloud variables override these)
 *   presence:    { status, rotateSeconds, list }       // bot status line, managed in /owner (see presence.js)
 *   announce:    { lastChannels: { guildId: channelId } }   // channels the owner chose for earlier announcements
 *   backup:      { lastAt, size, scope, error, failedAt }   // the weekly backup (see backup.js)
 *   restarts:    [ ms timestamps of automatic restarts ],
 *   pendingRestart: { reason, by, requestedAt, memory… }      // read after the restart
 * }
 *
 * Kept in memory and written through, so checking it on every interaction is free.
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'global-config.json');
const DEFAULTS = () => ({
  maintenance: { enabled: false, message: '', since: null, by: null },
  features:    { streamerAlerts: true, gameAlerts: true },
  blacklist:   { users: {}, guilds: {} },
  audit:       [],
  alerts:      { webhookUrl: null, webhookId: null, dm: null, levels: null, digestMinutes: null, memoryPercent: null },
  presence:    { status: 'dnd', rotateSeconds: 30, list: null },
  announce:    { lastChannels: {} },
  backup:      { lastAt: null, size: null, scope: null, error: null, failedAt: null },
  restarts:    [],
  pendingRestart: null,
});

let state = null;

function load() {
  if (state) return state;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
  const d = DEFAULTS();
  state = {
    ...d, ...raw,
    maintenance: { ...d.maintenance, ...(raw.maintenance || {}) },
    features:    { ...d.features,    ...(raw.features    || {}) },
    blacklist:   { users: { ...(raw.blacklist?.users || {}) }, guilds: { ...(raw.blacklist?.guilds || {}) } },
    audit:       Array.isArray(raw.audit) ? raw.audit : [],
    alerts:      { ...d.alerts, ...(raw.alerts || {}) },
    presence:    { ...d.presence, ...(raw.presence || {}) },
    announce:    { lastChannels: { ...(raw.announce?.lastChannels || {}) } },
    backup:      { ...d.backup, ...(raw.backup || {}) },
    restarts:    Array.isArray(raw.restarts) ? raw.restarts : [],
  };
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[globalConfig] save failed:', err.message);
  }
}

const get = () => load();

/** Change settings: update(cfg => { cfg.maintenance.enabled = true; }) */
function update(mutator) { const s = load(); mutator(s); save(); return s; }

// ── Convenience helpers ───────────────────────────────────────────────────────

const isMaintenance  = () => load().maintenance.enabled === true;
const featureEnabled = (name) => load().features[name] !== false;
const isUserBanned   = (id) => !!load().blacklist.users[String(id)];
const isGuildBanned  = (id) => !!load().blacklist.guilds[String(id)];

function pushAudit(entry) {
  update(s => {
    s.audit.push({ at: Date.now(), ...entry });
    if (s.audit.length > 200) s.audit.splice(0, s.audit.length - 200);
  });
}

/** Test helper: forget cached state so the file is re-read. */
function _reset() { state = null; }

module.exports = { get, update, isMaintenance, featureEnabled, isUserBanned, isGuildBanned, pushAudit, _reset, FILE };
