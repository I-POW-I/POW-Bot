/**
 * Welcome / leave post settings.
 *
 * Stored flat in the server's config (src/guildConfig.js) under a `welcome` or `leave` prefix, for example
 * welcomeFormat, welcomeStyle, welcomeCardTitle. A missing value means "use the default", so servers that never
 * customised anything keep looking exactly as before.
 *
 * Formats:
 *   card   the image card, with the message above it            (the original look)
 *   embed  a rich embed: title, text, avatar, footer and colour
 *   both   the image card shown inside the embed
 *   text   just the message
 *
 * Placeholders (card title and subtitle, message, embed title, text and footer, welcome DM):
 *   {user} display name   {username} account name   {mention} @mention   {server} server name
 *   {count} member count  {ordinal} "1,204th"       {accountage} how old the account is
 *   {joined} how long they were here (leave posts)  {rules} the server's rules channel
 */

const { getGuildConfig } = require('./guildConfig');
const { age } = require('./duration');

const TYPES = ['welcome', 'leave'];
const FORMATS = {
  card:  { label: 'Image card',          desc: 'The picture card with your message above it' },
  embed: { label: 'Rich embed',          desc: 'A title, text, avatar and footer in a coloured box' },
  both:  { label: 'Card inside an embed', desc: 'The picture card shown inside the rich embed' },
  text:  { label: 'Text only',           desc: 'Just your message' },
};
const STYLES = {
  classic:  { label: 'Classic',  desc: 'Floats on the chat background' },
  midnight: { label: 'Midnight', desc: 'Deep blue panel with an accent edge' },
  aurora:   { label: 'Aurora',   desc: 'Purple to teal gradient' },
  sunset:   { label: 'Sunset',   desc: 'Pink to orange gradient' },
  graphite: { label: 'Graphite', desc: 'Clean dark grey' },
};
const SHAPES = { circle: 'Circle', rounded: 'Rounded square' };

const DEFAULTS = {
  welcome: {
    title: '{user}', subtitle: '', message: '{mention}', accent: null,
    embedTitle: 'Welcome to {server}!', embedText: '{mention} just joined. You are member {ordinal}.', embedFooter: 'Account created {accountage} ago',
  },
  leave: {
    title: '{user}', subtitle: '{user} has left the server', message: '', accent: null,
    embedTitle: '{user} left', embedText: '{user} has left {server} after {joined}.', embedFooter: '{count} members',
  },
};
const DM_DEFAULT = 'Welcome to **{server}**, {user}! Have a look around and say hello.';
const LIMITS = { title: 40, subtitle: 60, message: 300, embedTitle: 100, embedText: 1000, embedFooter: 100, dm: 1000 };

/** The effective settings for a server ('welcome' or 'leave'). */
function options(guildId, type) {
  const c = getGuildConfig(guildId), p = type, d = DEFAULTS[type];
  const pick = (key, fallback) => (c[key] == null ? fallback : c[key]);
  const legacyCard = c[`${p}Card`] !== false;   // servers from before formats existed only had this on/off switch
  const format = FORMATS[c[`${p}Format`]] ? c[`${p}Format`] : legacyCard ? 'card' : 'text';
  return {
    format,
    card:        format === 'card' || format === 'both',
    style:       STYLES[c[`${p}Style`]] ? c[`${p}Style`] : 'classic',
    shape:       SHAPES[c[`${p}Shape`]] ? c[`${p}Shape`] : 'circle',
    title:       pick(`${p}CardTitle`, d.title) || d.title,
    subtitle:    pick(`${p}CardSubtitle`, d.subtitle),
    message:     pick(`${p}Message`, d.message),
    accent:      pick(`${p}Accent`, d.accent),
    embedTitle:  pick(`${p}EmbedTitle`, d.embedTitle),
    embedText:   pick(`${p}EmbedText`, d.embedText),
    embedFooter: pick(`${p}EmbedFooter`, d.embedFooter),
    avatar:      c[`${p}EmbedAvatar`] !== false,
    backText:    type === 'welcome' ? (c.welcomeBackText || '') : '',
  };
}

/** The config keys for a type, so setup can save edits. */
const keys = (type) => ({
  card: `${type}Card`, format: `${type}Format`, style: `${type}Style`, shape: `${type}Shape`,
  title: `${type}CardTitle`, subtitle: `${type}CardSubtitle`, message: `${type}Message`, accent: `${type}Accent`,
  embedTitle: `${type}EmbedTitle`, embedText: `${type}EmbedText`, embedFooter: `${type}EmbedFooter`, avatar: `${type}EmbedAvatar`,
});

/** Everything setup can reset for a type. */
const resetKeys = (type) => Object.values(keys(type)).concat(type === 'welcome' ? ['welcomeBackText'] : []);

const ordinal = (n) => {
  const v = Number(n) || 0, last = v % 100;
  const suffix = last >= 11 && last <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  return `${v.toLocaleString('en-GB')}${suffix}`;
};

/** The facts about a member that placeholders can use. */
function contextFor(member, { count, joinedMs = null, returning = false } = {}) {
  const guild = member.guild, user = member.user || member;
  const total = count ?? guild.memberCount;
  return {
    user: member.displayName || user.username, username: user.username, mention: `${member}`, server: guild.name,
    count: total, ordinal: ordinal(total), accountage: age(Date.now() - (user.createdTimestamp || Date.now())),
    joined: joinedMs == null ? 'a while' : age(joinedMs), rules: guild.rulesChannelId ? `<#${guild.rulesChannelId}>` : 'the rules', returning,
  };
}

/** Replace placeholders. Unknown ones are left untouched. */
function fill(text, ctx) {
  return String(text ?? '')
    .replace(/\{user\}/gi, ctx.user)
    .replace(/\{username\}/gi, ctx.username ?? ctx.user)
    .replace(/\{mention\}/gi, ctx.mention ?? ctx.user)
    .replace(/\{server\}/gi, ctx.server)
    .replace(/\{count\}/gi, String(ctx.count))
    .replace(/\{ordinal\}/gi, ctx.ordinal ?? String(ctx.count))
    .replace(/\{accountage\}/gi, ctx.accountage ?? '')
    .replace(/\{joined\}/gi, ctx.joined ?? '')
    .replace(/\{rules\}/gi, ctx.rules ?? 'the rules');
}

/** '#5865F2', '5865f2' or '#58f' -> '#5865F2', or null when it isn't a colour. */
function parseColour(input) {
  let v = String(input || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map(ch => ch + ch).join('');
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : null;
}

/**
 * Everything needed to post: the text above, the card image options and the embed.
 * A returning member gets the "welcome back" text in place of the normal text, when the server wrote one.
 */
function compose(guildId, type, ctx) {
  const o = options(guildId, type);
  const forImage = { ...ctx, mention: ctx.user };
  const back = ctx.returning && o.backText;
  const embedLike = o.format === 'embed' || o.format === 'both';
  return {
    format: o.format,
    card: o.card,
    text: fill(back && !embedLike ? o.backText : o.message, ctx).trim().slice(0, 2000),
    image: { title: fill(o.title, forImage), subtitle: fill(o.subtitle, forImage), accent: o.accent, style: o.style, shape: o.shape },
    embed: embedLike ? {
      title: fill(o.embedTitle, forImage).slice(0, 256), description: fill(back ? o.backText : o.embedText, ctx).slice(0, 4000),
      footer: fill(o.embedFooter, forImage).slice(0, 2048), colour: o.accent, avatar: o.avatar,
    } : null,
  };
}

module.exports = { TYPES, FORMATS, STYLES, SHAPES, DEFAULTS, DM_DEFAULT, LIMITS, options, keys, resetKeys, fill, ordinal, contextFor, parseColour, compose };
