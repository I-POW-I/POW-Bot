/**
 * Turns every embed the bot sends into a card image (see render.js), in one place.
 *
 * Instead of changing the 140-odd places that build embeds, the send methods in discord.js (interaction replies and
 * edits, channel and DM sends, webhook sends, message edits) are wrapped once. When a payload has embeds, each one is
 * drawn as a card, attached as an image, and any links in it become link buttons underneath.
 *
 * It never gets in the way: if drawing fails, or the owner switches "Card panels" off, the original embeds are sent.
 * A payload can opt out with `plainEmbeds: true`.
 */

const discord = require('discord.js');
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
const { renderEmbed, renderBest } = require('./render');
const style = require('./style');
const { log } = require('../logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOO_SLOW = Symbol('too slow');
// Discord wants an answer to a command or button within 3 seconds; if drawing takes longer than this, the interaction is deferred first
const DEFER_AFTER_MS = 1100;
// a command that already waited this long for the bot is answered with the plain embed: there is no time left to draw a card
const TOO_LATE_MS = 1500;

const CACHE = new Map(), CACHE_MS = 10 * 60 * 1000;

const SEND_METHODS = [
  // [method, is an edit]
  ['reply', false], ['followUp', false], ['editReply', true], ['update', true],
  ['send', false], ['edit', true], ['editMessage', true],
];

/** The argument that is a message payload: a plain object with an embeds list. (A Message also has `embeds`, so instances are skipped.) */
const payloadIndex = (args) => args.findIndex(a => a && typeof a === 'object' && !Array.isArray(a) && Object.getPrototypeOf(a) === Object.prototype && Array.isArray(a.embeds));

/** Link buttons already on the payload, so the same address is not offered twice. */
function existingLinks(components) {
  const urls = new Set();
  for (const r of components || []) {
    const row = typeof r?.toJSON === 'function' ? r.toJSON() : r;
    for (const c of row?.components || []) if (c?.url) urls.add(c.url);
  }
  return urls;
}
const toJSON = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e?.data ? { ...e.data } : e);

function resolverFor(source) {
  const client = source?.client || null;
  const guild = source?.guild || source?.channel?.guild || (client && source?.guildId ? client.guilds.cache.get(source.guildId) : null) || null;
  return (kind, id) => {
    try {
      if (kind === 'user') {
        const name = guild?.members.cache.get(id)?.displayName || client?.users.cache.get(id)?.username;
        return name ? { text: `@${name}` } : null;
      }
      if (kind === 'role') {
        const r = guild?.roles.cache.get(id);
        return r ? { text: `@${r.name}`, colour: r.color ? r.hexColor : null } : null;
      }
      if (kind === 'channel') {
        const c = guild?.channels.cache.get(id) || client?.channels.cache.get(id);
        return c?.name ? { text: `${c.isVoiceBased?.() ? '🔊 ' : '#'}${c.name}` } : null;
      }
    } catch { /* fall through */ }
    return null;
  };
}

/** The payload with embeds replaced by card images, or the payload unchanged. */
async function convert(payload, source, isEdit) {
  if (!payload || typeof payload !== 'object' || typeof payload === 'string') return payload;
  // `liveStamp: true` marks a panel that is edited again and again: as a card it gets a live "Updated … ago" line (Discord keeps it counting)
  if ('liveStamp' in payload) {
    const { liveStamp, ...rest } = payload;
    const out = await convert(rest, source, isEdit);
    if (liveStamp && out !== rest && Array.isArray(out.files) && !out.embeds?.length) return { ...out, content: `-# Updated <t:${Math.floor(Date.now() / 1000)}:R>` };
    return isEdit && liveStamp ? { ...out, content: '' } : out;
  }
  if (!Array.isArray(payload.embeds) || !payload.embeds.length || payload.plainEmbeds === true) return payload;
  const guildId = (source?.guild || source?.channel?.guild)?.id || source?.guildId || null;
  const look = style.styleFor(guildId, style.areaOf(source));
  if (look === 'embed') return payload;

  const embeds = payload.embeds.slice(0, 10).map(toJSON).filter(Boolean);
  if (!embeds.length) return payload;

  const files = Array.isArray(payload.files) ? [...payload.files] : [];
  const buffers = new Map();
  for (const f of files) if (f instanceof AttachmentBuilder && Buffer.isBuffer(f.attachment) && f.name) buffers.set(f.name, f.attachment);

  const resolve = resolverFor(source);
  // the same embed drawn again a moment later (a menu opened twice) is reused; anything with a clock or a picture is drawn fresh
  const raw = JSON.stringify(embeds), cacheable = buffers.size === 0 && !/<t:|attachment:\/\//.test(raw);
  const hit = cacheable ? CACHE.get(raw) : null;
  let rendered = hit && Date.now() - hit.at < CACHE_MS ? hit.rendered : null;
  if (!rendered) {
    try { rendered = await Promise.all(embeds.map(e => renderBest(e, { resolve, attachments: buffers }))); }
    catch (err) { log('WARN', 'Card render failed, sending the plain embed', { err }); return payload; }
    if (cacheable) { CACHE.set(raw, { at: Date.now(), rendered }); if (CACHE.size > 60) CACHE.delete(CACHE.keys().next().value); }
  }

  // smart mode: a card Discord would shrink too much to read is sent as a classic embed instead
  if (look === 'auto' && rendered.some(r => r.scale < style.MIN_SMART_SCALE)) return payload;

  // an attachment an embed only existed to show is now part of the card
  const used = new Set();
  for (const e of embeds) for (const u of [e.image?.url, e.thumbnail?.url]) { const m = String(u || '').match(/^attachment:\/\/(.+)$/); if (m) used.add(decodeURIComponent(m[1])); }
  const keep = files.filter(f => !(f instanceof AttachmentBuilder && used.has(f.name)));

  const stamp = Date.now().toString(36);
  const cards = rendered.map((r, i) => new AttachmentBuilder(r.png, { name: `card-${stamp}-${i}.png`, description: r.alt || 'Card' }));

  const seen = existingLinks(payload.components), links = [];
  for (const r of rendered) for (const l of r.links) if (!seen.has(l.url) && /^https?:\/\//.test(l.url)) { seen.add(l.url); links.push(l); }
  const components = Array.isArray(payload.components) ? [...payload.components] : [];
  if (links.length && components.length < 5) {
    const row = new ActionRowBuilder().addComponents(links.slice(0, 5).map(l => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label.slice(0, 80) || 'Open').setURL(l.url)));
    components.push(row);
  }

  const out = { ...payload, embeds: [], files: [...keep, ...cards] };
  if (components.length || payload.components) out.components = components;
  if (isEdit && payload.attachments === undefined) out.attachments = [];
  return out;
}

function wrap(proto, name, isEdit) {
  const original = proto[name];
  if (typeof original !== 'function' || original.__cards) return;
  const wrapped = async function (...args) {
    const index = payloadIndex(args);
    if (index < 0) return original.apply(this, args);
    try {
      // the first answer to a command or button has to arrive within 3 seconds: if drawing is slow, defer and edit instead
      const first = (name === 'reply' || name === 'update') && typeof this.deferReply === 'function' && !this.deferred && !this.replied;
      const age = first && this.createdTimestamp ? Date.now() - this.createdTimestamp : 0;
      if (first && age > TOO_LATE_MS) { const { liveStamp, ...plain } = args[index]; void liveStamp; args[index] = plain; return original.apply(this, args); }
      const work = convert(args[index], this, isEdit);
      if (first) {
        const result = await Promise.race([work, sleep(Math.max(150, DEFER_AFTER_MS - age)).then(() => TOO_SLOW)]);
        if (result === TOO_SLOW) {
          const ephemeral = !!(args[index].ephemeral || (args[index].flags != null && (Number(args[index].flags) & 64)));
          if (name === 'reply') await this.deferReply(ephemeral ? { flags: 64 } : {}); else await this.deferUpdate();
          const done = await work;
          const { flags, ephemeral: _e, ...rest } = done; void flags; void _e;
          return this.editReply(rest);
        }
        args[index] = result;
      } else args[index] = await work;
    } catch (err) { log('WARN', 'Card conversion skipped', { err }); }
    return original.apply(this, args);
  };
  wrapped.__cards = true;
  proto[name] = wrapped;
}

let installed = false;
/** Wrap the send methods once. Safe to call more than once. */
function install() {
  if (installed) return;
  installed = true;
  for (const exported of Object.values(discord)) {
    const proto = typeof exported === 'function' ? exported.prototype : null;
    if (!proto) continue;
    for (const [name, isEdit] of SEND_METHODS) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) wrap(proto, name, isEdit);
    }
  }
  // load fonts and emoji now, so the first real card is not slow
  setImmediate(() => renderEmbed({ title: 'Ready', description: 'Loading 🙂 ✅ ⚠️' }).catch(() => {}));
}

module.exports = { install, convert };
