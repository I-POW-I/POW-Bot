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
const { renderEmbed } = require('./render');
const { log } = require('../logger');

const SEND_METHODS = [
  // [method, payload argument index, is an edit]
  ['reply', 0, false], ['followUp', 0, false], ['editReply', 0, true], ['update', 0, true],
  ['send', 0, false], ['edit', 0, true], ['editMessage', 1, true],
];

const enabled = () => { try { return require('../globalConfig').featureEnabled('cardPanels'); } catch { return true; } };
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
  if (!Array.isArray(payload.embeds) || !payload.embeds.length || payload.plainEmbeds === true || !enabled()) return payload;

  const embeds = payload.embeds.slice(0, 10).map(toJSON).filter(Boolean);
  if (!embeds.length) return payload;

  const files = Array.isArray(payload.files) ? [...payload.files] : [];
  const buffers = new Map();
  for (const f of files) if (f instanceof AttachmentBuilder && Buffer.isBuffer(f.attachment) && f.name) buffers.set(f.name, f.attachment);

  const resolve = resolverFor(source);
  let rendered;
  try { rendered = await Promise.all(embeds.map(e => renderEmbed(e, { resolve, attachments: buffers }))); }
  catch (err) { log('WARN', 'Card render failed, sending the plain embed', { err }); return payload; }

  // an attachment an embed only existed to show is now part of the card
  const used = new Set();
  for (const e of embeds) for (const u of [e.image?.url, e.thumbnail?.url]) { const m = String(u || '').match(/^attachment:\/\/(.+)$/); if (m) used.add(decodeURIComponent(m[1])); }
  const keep = files.filter(f => !(f instanceof AttachmentBuilder && used.has(f.name)));

  const stamp = Date.now().toString(36);
  const cards = rendered.map((r, i) => new AttachmentBuilder(r.png, { name: `card-${stamp}-${i}.png`, description: r.alt || 'Card' }));

  const seen = new Set(), links = [];
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

function wrap(proto, name, index, isEdit) {
  const original = proto[name];
  if (typeof original !== 'function' || original.__cards) return;
  const wrapped = async function (...args) {
    try { args[index] = await convert(args[index], this, isEdit); } catch (err) { log('WARN', 'Card conversion skipped', { err }); }
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
    for (const [name, index, isEdit] of SEND_METHODS) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) wrap(proto, name, index, isEdit);
    }
  }
}

module.exports = { install, convert };
