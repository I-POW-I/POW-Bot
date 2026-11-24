/**
 * Per-guild config stored in data/guild-config.json
 *
 * Shape:
 * {
 *   [guildId]: {
 *     logChannels:    { voice, messages },
 *     panelChannelId, panelMessageId,
 *     lastChannelId,
 *     stats:          { joinedAt, reconnectCount },
 *     verifyRoleId,   verifyChannelId,  verifyMessageId,
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'guild-config.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getGuildConfig(guildId) {
  return readAll()[guildId] || {};
}

function setGuildConfig(guildId, updates) {
  const all = readAll();
  all[guildId] = { ...all[guildId], ...updates };
  writeAll(all);
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
  getGuildConfig,  setGuildConfig,
  getLogChannel,   setLogChannel,
  setLastChannel,  clearLastChannel,
  setStats,        getStats,
  getBotControlRoleId,
};
