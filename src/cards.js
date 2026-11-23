/**
 * Welcome / leave post settings.
 *
 * Stored in the server's config (src/guildConfig.js):
 *   welcomeCard, welcomeCardTitle, welcomeCardSubtitle, welcomeAccent, welcomeMessage
 *   leaveCard,   leaveCardTitle,   leaveCardSubtitle,   leaveAccent,   leaveMessage
 * A missing value means "use the default", so servers that never customised anything look exactly as before.
 *
 * Placeholders (in the title, subtitle and message):
 *   {user}     the member's display name       {mention}  @mention (message only; a name on the image)
 *   {server}   the server name                 {count}    the member count
 */

const { getGuildConfig } = require('./guildConfig');

const DEFAULTS = {
  welcome: { title: '{user}', subtitle: '',                          message: '{mention}', accent: null, card: true },
  leave:   { title: '{user}', subtitle: '{user} has left the server', message: '',          accent: null, card: true },
};
const PREFIX = { welcome: 'welcome', leave: 'leave' };
const LIMITS = { title: 40, subtitle: 60, message: 300 };

/** The effective settings for a server ('welcome' or 'leave'). */
function options(guildId, type) {
  const c = getGuildConfig(guildId), p = PREFIX[type], d = DEFAULTS[type];
  const pick = (key, fallback) => (c[key] == null ? fallback : c[key]);
  return {
    card:     c[`${p}Card`] !== false,
    title:    pick(`${p}CardTitle`, d.title) || d.title,
    subtitle: pick(`${p}CardSubtitle`, d.subtitle),
    message:  pick(`${p}Message`, d.message),
    accent:   pick(`${p}Accent`, d.accent),
  };
}

/** The config keys for a type, so setup can save edits. */
const keys = (type) => ({ card: `${PREFIX[type]}Card`, title: `${PREFIX[type]}CardTitle`, subtitle: `${PREFIX[type]}CardSubtitle`, message: `${PREFIX[type]}Message`, accent: `${PREFIX[type]}Accent` });

/** Replace placeholders. Unknown ones are left untouched. */
function fill(text, ctx) {
  return String(text ?? '')
    .replace(/\{user\}/gi, ctx.user)
    .replace(/\{mention\}/gi, ctx.mention ?? ctx.user)
    .replace(/\{server\}/gi, ctx.server)
    .replace(/\{count\}/gi, String(ctx.count));
}

/** '#5865F2', '5865f2' or '#58f' -> '#5865F2', or null when it isn't a colour. */
function parseColour(input) {
  let v = String(input || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map(ch => ch + ch).join('');
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : null;
}

/**
 * Everything needed to post a card: the text above it and the image options.
 * @param {'welcome'|'leave'} type
 * @param {{ user: string, mention?: string, server: string, count: number }} ctx
 */
function compose(guildId, type, ctx) {
  const o = options(guildId, type);
  const forImage = { ...ctx, mention: ctx.user };
  return {
    card: o.card,
    text: fill(o.message, ctx).trim().slice(0, 2000),
    image: { title: fill(o.title, forImage), subtitle: fill(o.subtitle, forImage), accent: o.accent },
  };
}

module.exports = { DEFAULTS, LIMITS, options, keys, fill, parseColour, compose };
