/**
 * Announcement styles and history.
 *
 * Each style turns a few typed fields into a ready-to-send message. The changelog style matches the
 * "title, then a diff block" look; the others are embeds. Nothing here sends anything: the owner screen
 * (src/ownerAnnounce.js) previews, lets the owner choose servers and channels, then sends.
 *
 * Every sent announcement is kept in the `announcements` table so /changelog can show what changed.
 */

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { run, selectAll, selectOne } = require('./database');

const COLOURS = { update: 0x5865F2, maintenance: 0xFAA61A, event: 0x9B59B6, resolved: 0x57F287, investigating: 0xED4245, identified: 0xFAA61A, monitoring: 0x5865F2 };
const MAX_MESSAGE = 1900;

/** One field of a style: shown as a text box in the form. */
const field = (id, label, o = {}) => ({ id, label, style: o.long ? 'long' : 'short', required: o.required !== false, max: o.max || (o.long ? 1000 : 100), placeholder: o.placeholder || '' });

const lines = (text) => String(text || '').split('\n').map(l => l.trim().replace(/^[-+*•]\s*/, '')).filter(Boolean);
const safe = (text) => String(text).replace(/```/g, "'''");

const STYLES = {
  changelog: {
    label: 'Changelog', emoji: '📋', desc: 'Title and a coloured list of what was added, fixed and removed',
    fields: [
      field('title', 'Title', { max: 80, placeholder: 'POW-Bot 5.3 update' }),
      field('added', 'Added or improved (one per line)', { long: true, required: false, placeholder: 'Voice leaderboard with role rewards' }),
      field('fixed', 'Fixed (one per line)', { long: true, required: false, placeholder: 'Verify buttons no longer time out' }),
      field('removed', 'Removed (one per line)', { long: true, required: false, placeholder: 'The Bot Info button' }),
      field('note', 'Note (optional, shown under the list)', { required: false, max: 200 }),
    ],
    render(v) {
      const diff = [...lines(v.added).map(l => `+ ${safe(l)}`), ...lines(v.fixed).map(l => `+ Fixed: ${safe(l)}`), ...lines(v.removed).map(l => `- ${safe(l)}`)];
      if (!diff.length) return { error: 'Add at least one line to Added, Fixed or Removed.' };
      const content = [`**${v.title}**`, '', '```diff', ...diff, '```', v.note ? v.note : null].filter(x => x !== null).join('\n');
      return { content };
    },
    kind: 'changelog',
  },
  update: {
    label: 'Update', emoji: '📣', desc: 'A general announcement about the bot',
    fields: [field('title', 'Title', { max: 100 }), field('body', 'Message', { long: true, max: 1500 })],
    render: (v) => ({ embeds: [new EmbedBuilder().setColor(COLOURS.update).setTitle(v.title).setDescription(v.body).setFooter({ text: 'POW-Bot' })] }),
    kind: 'update',
  },
  maintenance: {
    label: 'Maintenance notice', emoji: '🔧', desc: 'Planned downtime, with when and for how long',
    fields: [
      field('when', 'When', { placeholder: 'Tonight at 23:00 (UK time)' }),
      field('duration', 'Expected duration', { placeholder: 'About 10 minutes' }),
      field('details', 'What members should know', { long: true, required: false, max: 800, placeholder: 'The bot will be offline briefly. Nothing needs to be done.' }),
    ],
    render: (v) => ({ embeds: [new EmbedBuilder().setColor(COLOURS.maintenance).setTitle('Scheduled maintenance')
      .setDescription(v.details || null).addFields({ name: 'When', value: v.when, inline: true }, { name: 'Expected duration', value: v.duration, inline: true }).setFooter({ text: 'POW-Bot' })] }),
    kind: 'maintenance',
  },
  incident: {
    label: 'Incident update', emoji: '🚨', desc: 'Something went wrong: investigating, identified, monitoring or resolved',
    fields: [
      field('status', 'Status', { max: 20, placeholder: 'Investigating, Identified, Monitoring or Resolved' }),
      field('title', 'What happened', { max: 100 }),
      field('details', 'Details', { long: true, max: 1200 }),
    ],
    render(v) {
      const status = ['investigating', 'identified', 'monitoring', 'resolved'].find(s => s.startsWith(String(v.status).trim().toLowerCase().slice(0, 4)) && String(v.status).trim().length >= 4);
      if (!status) return { error: 'Status must be Investigating, Identified, Monitoring or Resolved.' };
      const label = status[0].toUpperCase() + status.slice(1);
      return { embeds: [new EmbedBuilder().setColor(COLOURS[status]).setTitle(v.title).setDescription(v.details).addFields({ name: 'Status', value: label, inline: true }).setFooter({ text: 'POW-Bot' })] };
    },
    kind: 'incident',
  },
  event: {
    label: 'Event or news', emoji: '🎉', desc: 'Something happening, with a date',
    fields: [field('title', 'Title', { max: 100 }), field('when', 'When', { required: false, placeholder: 'Saturday 14 December, 19:00' }), field('details', 'Details', { long: true, max: 1200 })],
    render: (v) => ({ embeds: [new EmbedBuilder().setColor(COLOURS.event).setTitle(v.title).setDescription(v.details).addFields(...(v.when ? [{ name: 'When', value: v.when, inline: true }] : [])).setFooter({ text: 'POW-Bot' })] }),
    kind: 'event',
  },
  plain: {
    label: 'Plain message', emoji: '💬', desc: 'Just text, no embed',
    fields: [field('title', 'Heading (optional)', { required: false, max: 100 }), field('body', 'Message', { long: true, max: 1800 })],
    render: (v) => ({ content: [v.title ? `**${v.title}**` : null, v.body].filter(Boolean).join('\n') }),
    kind: 'plain',
  },
};

/** Trim the typed values, then build the message. Returns { payload, title } or { error }. */
function build(style, values) {
  const s = STYLES[style];
  if (!s) return { error: 'Unknown style.' };
  const v = {};
  for (const f of s.fields) {
    v[f.id] = String(values[f.id] ?? '').trim();
    if (f.required && !v[f.id]) return { error: `"${f.label}" is required.` };
  }
  const out = s.render(v);
  if (out.error) return { error: out.error };
  if ((out.content || '').length > MAX_MESSAGE) return { error: `That is ${out.content.length} characters; the limit is ${MAX_MESSAGE}. Shorten it.` };
  return { payload: { ...out, allowedMentions: { parse: [] } }, title: v.title || s.label };
}

// ── History ───────────────────────────────────────────────────────────────────

function record({ style, title, payload, by, servers }) {
  const body = JSON.stringify({ content: payload.content || null, embeds: (payload.embeds || []).map(e => (e.toJSON ? e.toJSON() : e)) });
  run('INSERT INTO announcements (style, title, payload, sent_at, sent_by, servers) VALUES (?, ?, ?, ?, ?, ?)', [style, title, body, Date.now(), by, servers]);
}

const recent = (limit = 10) => selectAll('SELECT id, style, title, sent_at, servers FROM announcements ORDER BY sent_at DESC LIMIT ?', [limit]);

/** Changelogs and updates, newest first (what members see in /changelog). */
const publicEntries = (limit = 10) => selectAll("SELECT id, style, title, sent_at FROM announcements WHERE style IN ('changelog', 'update') ORDER BY sent_at DESC LIMIT ?", [limit]);

function entry(id) {
  const row = selectOne('SELECT * FROM announcements WHERE id = ?', [id]);
  if (!row) return null;
  let payload = {}; try { payload = JSON.parse(row.payload); } catch { /* ignore */ }
  return { ...row, payload };
}

/** The /changelog screen: the newest entry, with a menu for older ones. */
function changelogView(id) {
  const items = publicEntries(10);
  if (!items.length) return { content: 'No updates have been published yet.', embeds: [], components: [] };
  const e = entry(items.some(i => i.id === Number(id)) ? Number(id) : items[0].id);
  const menu = new StringSelectMenuBuilder().setCustomId('cl:pick').setPlaceholder('Older updates')
    .addOptions(items.map(i => ({ label: i.title.slice(0, 100), value: String(i.id), description: new Date(i.sent_at).toISOString().slice(0, 10), default: i.id === e.id })));
  return { content: e.payload.content || null, embeds: (e.payload.embeds || []).map(x => EmbedBuilder.from(x)), components: [new ActionRowBuilder().addComponents(menu)] };
}

module.exports = { changelogView, STYLES, build, record, recent, publicEntries, entry, MAX_MESSAGE };
