/**
 * Per-guild config stored in data/guild-config.json
 *
 * Shape:
 * {
 *   [guildId]: {
 *     logChannels:    { voice, messages },
 *     panelChannelId, panelMessageId, panelRepostMinutes (0 = edit in place),
 *     lastChannelId,
 *     stats:          { joinedAt, reconnectCount },
 *     verifyRoleId,   verifyChannelId,  verifyMessageId,
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'guild-config.json');

// The file is read once and kept in memory: this is called for every message and every panel update, and used to
// read and parse the whole file each time. Every change is still written straight back to the file.
let cache = null;

function readAll() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function writeAll(data) {
  cache = data;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);   // a crash part-way can never leave a half-written file
}

/** A copy, so callers can change what they get without changing the saved settings by accident. */
function getGuildConfig(guildId) {
  const c = readAll()[guildId];
  return c ? structuredClone(c) : {};
}

/** Every server that has settings saved. */
const listGuildIds = () => Object.keys(readAll());

function setGuildConfig(guildId, updates) {
  const all = readAll();
  all[guildId] = { ...all[guildId], ...updates };
  writeAll(all);
}

/** Forget everything stored for a server (used when the bot is removed from it). */
function deleteGuildConfig(guildId) {
  const all = readAll();
  if (all[guildId]) { delete all[guildId]; writeAll(all); }
}

function getLogChannel(guildId, type) {
  return getGuildConfig(guildId).logChannels?.[type] || null;
}

function setLogChannel(guildId, type, channelId) {
  const all = readAll();
  if (!all[guildId]) all[guildId] = {};
  if (!all[guildId].logChannels) all[guildId].logChannels = {};
  all[guildId].logChannels[type] = channelId;
  writeAll(all);
}

function setLastChannel(guildId, channelId) {
  const all = readAll();
  if (!all[guildId]) all[guildId] = {};
  all[guildId].lastChannelId = channelId;
  writeAll(all);
}

function clearLastChannel(guildId) {
  const all = readAll();
  if (all[guildId]) {
    delete all[guildId].lastChannelId;
    writeAll(all);
  }
}

function setStats(guildId, { joinedAt, reconnectCount }) {
  const all = readAll();
  if (!all[guildId]) all[guildId] = {};
  all[guildId].stats = {
    joinedAt:       joinedAt instanceof Date ? joinedAt.toISOString() : joinedAt,
    reconnectCount: reconnectCount || 0,
  };
  writeAll(all);
}

function getStats(guildId) {
  const raw = getGuildConfig(guildId).stats;
  if (!raw) return { joinedAt: null, reconnectCount: 0 };
  return {
    joinedAt:       raw.joinedAt ? new Date(raw.joinedAt) : null,
    reconnectCount: raw.reconnectCount || 0,
  };
}

/**
 * Get the role ID allowed to use Leave and Force Leave buttons.
 * Returns null if not set — falls back to server owner.
 */
function getBotControlRoleId(guildId) {
  return getGuildConfig(guildId).botControlRoleId || null;
}

module.exports = {
  getGuildConfig,  setGuildConfig,  deleteGuildConfig,  listGuildIds,
  getLogChannel,   setLogChannel,
  setLastChannel,  clearLastChannel,
  setStats,        getStats,
  getBotControlRoleId,
};
