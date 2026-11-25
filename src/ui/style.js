/**
 * Which look a message gets: image cards, the classic Discord embeds, or smart (cards, but classic embeds when a message is
 * too long to read as a picture: Discord shows pictures at a limited height, so long text becomes small).
 *
 * Staff choose in /setup > Display for their own server: one choice for everything, and an override for each area.
 * The bot owner can switch cards off for the whole bot (/owner > Maintenance and features > Card panels) or force
 * either look in a single server (the owner's per-server override).
 *
 * Areas:  setup (the /setup screens)   logs (entries in log channels)   commands (replies to commands and buttons)
 *         posts (everything else the bot posts: alerts, game updates, panels)   owner (the /owner screens)
 *
 * Saved per server as  uiStyle: { all: 'auto'|'card'|'embed', setup, logs, commands, posts }   (missing = follow "all", then smart)
 */

const { getGuildConfig } = require('../guildConfig');

const AREAS = [
  { key: 'setup',    label: 'Setup screens',        desc: 'The /setup pages' },
  { key: 'logs',     label: 'Logs',                 desc: 'Entries in your log channels' },
  { key: 'commands', label: 'Commands and buttons', desc: 'Replies to commands, buttons and menus' },
  { key: 'posts',    label: 'Posts and alerts',     desc: 'Panels, game updates, streamer and free game alerts' },
];
const STYLES = ['auto', 'card', 'embed'];
const MIN_SMART_SCALE = 0.62;   // a card Discord would shrink below this (a picture shows at most ~550x400) is sent as a classic embed in smart mode

const globalOn = () => { try { return require('../globalConfig').featureEnabled('cardPanels'); } catch { return true; } };
const ownerForced = (guildId) => { try { const v = require('../globalConfig').get().uiOverrides?.[guildId]; return STYLES.includes(v) ? v : null; } catch { return null; } };

/** The server's saved choices. */
const settings = (guildId) => {
  const u = (guildId && getGuildConfig(guildId).uiStyle) || {};
  return { all: STYLES.includes(u.all) ? u.all : null, ...Object.fromEntries(AREAS.map(a => [a.key, STYLES.includes(u[a.key]) ? u[a.key] : null])) };
};

/** 'auto', 'card' or 'embed' for an area of a server. */
function styleFor(guildId, area) {
  if (!globalOn()) return 'embed';
  if (area === 'owner' || !guildId) return 'auto';
  return ownerForced(guildId) || settings(guildId)[area] || settings(guildId).all || 'auto';
}

/** Which area a send belongs to, from what is sending it. */
function areaOf(source) {
  try {
    if (!source) return 'posts';
    const id = String(source.commandName || source.customId || '');
    if (source.commandName) return source.commandName === 'setup' ? 'setup' : source.commandName === 'owner' ? 'owner' : 'commands';
    if (source.customId) return id.startsWith('setup:') ? 'setup' : id.startsWith('owner:') ? 'owner' : 'commands';
    const guild = source.guild || source.channel?.guild;
    const channelId = source.channelId || source.channel?.id || source.id;
    if (guild && channelId && require('../messageStore').isLogChannel(guild.id, channelId)) return 'logs';
  } catch { /* fall through */ }
  return 'posts';
}

module.exports = { AREAS, STYLES, MIN_SMART_SCALE, settings, styleFor, areaOf };
