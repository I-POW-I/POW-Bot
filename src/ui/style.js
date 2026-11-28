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
 * Two kinds of message:
 *   showpieces  things people look at and share: the live panel, My card and member cards, Wrapped, busy times, the weekly recap, the leaderboard, and streamer, game update and
 *               free game posts (these three also repeat their people and channels as clickable mentions). Picture cards by default.
 *   everything else  verification, reaction roles, help, setup, confirmations, polls, announcements, log entries, errors. Classic embeds by default:
 *               they are quick to send and the text can be selected, read aloud and followed as links.
 * "Smart" (the default) means exactly that. A server can choose a look for the showpieces (`cards`), for an area, or for everything.
 *
 * Saved per server as  uiStyle: { all, cards, setup, logs, commands, posts }, each 'auto'|'card'|'embed'  (missing = follow "all", then smart)
 */

const { getGuildConfig } = require('../guildConfig');

const AREAS = [
  { key: 'setup',    label: 'Setup screens',        desc: 'The /setup pages' },
  { key: 'logs',     label: 'Logs',                 desc: 'Entries in your log channels' },
  { key: 'commands', label: 'Commands and buttons', desc: 'Replies to commands, buttons and menus' },
  { key: 'posts',    label: 'Posts and alerts',     desc: 'Verification, reaction roles, announcements and anything else not made to be looked at' },
];
const STYLES = ['auto', 'card', 'embed'];
const MIN_SMART_SCALE = 0.62;   // a card Discord would shrink below this (a picture shows at most ~550x400) is sent as a classic embed in smart mode

const globalOn = () => { try { return require('../globalConfig').featureEnabled('cardPanels'); } catch { return true; } };
const ownerForced = (guildId) => { try { const v = require('../globalConfig').get().uiOverrides?.[guildId]; return STYLES.includes(v) ? v : null; } catch { return null; } };

/** The server's saved choices. */
const settings = (guildId) => {
  const u = (guildId && getGuildConfig(guildId).uiStyle) || {};
  return { all: STYLES.includes(u.all) ? u.all : null, cards: STYLES.includes(u.cards) ? u.cards : null, ...Object.fromEntries(AREAS.map(a => [a.key, STYLES.includes(u[a.key]) ? u[a.key] : null])) };
};

/**
 * 'auto' (a card, or a classic embed if it is too long to read as a picture), 'card' or 'embed' for a message.
 * `showpiece` marks the messages meant to be looked at (see the top of this file).
 */
function styleFor(guildId, area, showpiece = false) {
  if (!globalOn()) return 'embed';
  const show = showpiece;
  const resolve = (v) => (v === 'card' || v === 'embed' ? v : show ? 'auto' : 'embed');
  if (area === 'owner' || !guildId) return resolve(null);
  const forced = ownerForced(guildId);
  if (forced) return resolve(forced);
  const s = settings(guildId);
  return resolve(show ? (s.cards || s.all) : (s[area] || s.all));
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

const ACCENTS = { default: ['Default blue', null], green: ['Green', 0x57F287], teal: ['Teal', 0x1ABC9C], purple: ['Purple', 0x9B59B6], pink: ['Pink', 0xEB459E], red: ['Red', 0xED4245], orange: ['Orange', 0xE67E22], gold: ['Gold', 0xFFC857], grey: ['Grey', 0x99AAB5] };
/** The server's accent colour as a number, or null for the default. */
const accentOf = (guildId) => { const k = getGuildConfig(guildId).accent; return ACCENTS[k]?.[1] ?? null; };

module.exports = { ACCENTS, accentOf, AREAS, STYLES, MIN_SMART_SCALE, settings, styleFor, areaOf };
