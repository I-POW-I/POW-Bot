const { duration } = require('./duration');
/**
 * Stores metadata for every active voice connection.
 * Key: guildId
 * Value: { channelId, channelName, guildName, joinedAt, reconnectCount }
 */

const store = new Map();

/**
 * @param {string} guildId
 * @param {{ channelId, channelName, guildName, joinedAt?, reconnectCount? }} meta
 */
function setConnection(guildId, { channelId, channelName, guildName, joinedAt, reconnectCount }) {
  store.set(guildId, {
    channelId,
    channelName,
    guildName,
    joinedAt:       joinedAt       || new Date(),
    reconnectCount: reconnectCount || 0,
  });
}

function clearConnection(guildId) {
  store.delete(guildId);
}

function incrementReconnect(guildId) {
  const entry = store.get(guildId);
  if (entry) entry.reconnectCount += 1;
}

function getEntry(guildId) {
  return store.get(guildId) || null;
}

function getAllEntries() {
  return [...store.entries()];
}

function formatUptime(joinedAt) {
  return duration(Date.now() - new Date(joinedAt).getTime(), { seconds: true });
}

module.exports = { setConnection, clearConnection, incrementReconnect, getEntry, getAllEntries, formatUptime };
