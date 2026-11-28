/**
 * A server's time zone, used where the bot shows a time of day (busy times, Wrapped's busiest hour).
 * Each server can choose in /setup > Display; until then it follows the bot's own TZ setting, and UK time if that is not set.
 */

const { getGuildConfig } = require('./guildConfig');

const ZONES = [
  ['Europe/London', 'UK time'], ['Europe/Dublin', 'Ireland'], ['Europe/Paris', 'Central Europe (Paris, Berlin)'], ['Europe/Athens', 'Eastern Europe (Athens)'],
  ['Europe/Moscow', 'Moscow'], ['Asia/Dubai', 'Gulf (Dubai)'], ['Asia/Kolkata', 'India'], ['Asia/Singapore', 'Singapore / Perth'], ['Asia/Tokyo', 'Japan / Korea'],
  ['Australia/Sydney', 'Sydney / Melbourne'], ['Pacific/Auckland', 'New Zealand'], ['America/Sao_Paulo', 'Brazil'], ['America/New_York', 'US Eastern'],
  ['America/Chicago', 'US Central'], ['America/Denver', 'US Mountain'], ['America/Los_Angeles', 'US Pacific'], ['UTC', 'UTC'],
];
const DEFAULT = process.env.TZ && ZONES.some(z => z[0] === process.env.TZ) ? process.env.TZ : 'Europe/London';

const zoneOf = (guildId) => { const z = getGuildConfig(guildId).timezone; return ZONES.some(x => x[0] === z) ? z : DEFAULT; };
/** '12' (9:00 PM) or '24' (21:00) — the server's choice in /setup > Display, 12 hour until then. */
const clockOf = (guildId) => (getGuildConfig(guildId).clock === '24' ? '24' : '12');
const hourLabel = (h, clock = '12') => (clock === '24' ? `${String(h).padStart(2, '0')}:00` : `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`);
const labelOf = (zone) => (ZONES.find(z => z[0] === zone) || [null, zone])[1];

/** How far ahead of UTC the zone is at that moment, in milliseconds (daylight saving included). */
function offsetMs(zone, ms = Date.now()) {
  if (zone === 'UTC') return 0;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** The moment shifted so its UTC clock reads as the zone's local clock: read it with getUTCHours() and friends. */
const local = (zone, ms) => ms + offsetMs(zone, ms);

module.exports = { ZONES, DEFAULT, zoneOf, clockOf, hourLabel, labelOf, offsetMs, local };
