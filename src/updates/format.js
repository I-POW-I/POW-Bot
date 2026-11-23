/**
 * Patch-note formatting.
 *
 *   raw text (Steam BBCode, HTML, or plain)  →  blocks  →  a short, readable Discord card
 *
 * Blocks: { t:'h', text, level } · { t:'p', text } · { t:'li', text, ordered, n } · { t:'hr' }
 *
 * The card shows a one-line summary, then grouped bullet lists (a few per section, with
 * "…and N more"), the game image at the bottom, and a "Read full notes" button — instead
 * of one giant wall of text.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ── Text helpers ──────────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', times: '×', rarr: '→', larr: '←', deg: '°', copy: '©', reg: '®', trade: '™' };

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
const safeChar = (code) => { try { return String.fromCodePoint(code); } catch { return ''; } };

const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s; };

/** One-line clean-up: collapse spaces, keep **bold**. */
const tidy = (s) => String(s).replace(/[ \t\u00A0]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\*\*\s*\*\*/g, '').replace(/\*\s*\*/g, '').trim();

// ── BBCode (Steam) → HTML ─────────────────────────────────────────────────────

const BB_NAMES = 'p|h[1-6]|b|i|u|s|strike|spoiler|url|img|list|ulist|olist|hr|quote|code|table|tr|th|td|previewyoutube|noparse|center|size|color|font|dynamiclink|sup|sub';

function bbcodeToHtml(input) {
  let s = String(input).replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').replace(/\{STEAM_CLAN_IMAGE\}/g, 'https://clan.fastly.steamstatic.com/images');
  s = s.replace(/\[noparse\]([\s\S]*?)\[\/noparse\]/gi, (_, x) => x.replace(/</g, '&lt;'));

  s = s
    .replace(/\[h([1-6])\]/gi, '<h$1>').replace(/\[\/h([1-6])\]/gi, '</h$1>')
    .replace(/\[(?:b)\]/gi, '<b>').replace(/\[\/b\]/gi, '</b>')
    .replace(/\[(?:i)\]/gi, '<i>').replace(/\[\/i\]/gi, '</i>')
    .replace(/\[p(?:=[^\]]*)?\]/gi, '<p>').replace(/\[\/p\]/gi, '</p>')
    .replace(/\[(?:list|ulist)(?:=[^\]]*)?\]/gi, '<ul>').replace(/\[\/(?:list|ulist)\]/gi, '</ul>')
    .replace(/\[olist\]/gi, '<ol>').replace(/\[\/olist\]/gi, '</ol>')
    .replace(/\[\*\]/g, '<li>')
    .replace(/\[hr\]/gi, '<hr>')
    .replace(/\[quote(?:=[^\]]*)?\]/gi, '<blockquote>').replace(/\[\/quote\]/gi, '</blockquote>')
    .replace(/\[table[^\]]*\]/gi, '<table>').replace(/\[\/table\]/gi, '</table>')
    .replace(/\[tr\]/gi, '<tr>').replace(/\[\/tr\]/gi, '</tr>')
    .replace(/\[t[hd][^\]]*\]/gi, '<td>').replace(/\[\/t[hd]\]/gi, '</td>')
    .replace(/\[img[^\]]*\]\s*([^\[\s]+?)\s*\[\/img\]/gi, '<img src="$1">')
    .replace(/\[previewyoutube=[^\]]*\]\[\/previewyoutube\]/gi, '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[url\][\s\S]*?\[\/url\]/gi, '');

  // Everything else that is clearly BBCode: drop the tag, keep the text ("[Bug fix]" style text is left alone)
  s = s.replace(new RegExp(`\\[\\/?(?:${BB_NAMES})(?:=[^\\]]*)?\\]`, 'gi'), '');
  return s;
}

// ── HTML → blocks ─────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'table', 'ul', 'ol', 'tr', 'pre', 'figure', 'main', 'dl', 'dt', 'dd']);
const BULLET_LINE = /^(?:\d{1,3}[.)]|[-•*–·▪●])\s+(?=\S)/;

function htmlToBlocks(html) {
  const cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|button|iframe)\b[\s\S]*?<\/\1>/gi, '');

  const blocks = [], images = [];
  const lists = [];
  let buf = '', inLi = false, heading = null, liOrdered = false, liN = 0;

  const flushParagraph = () => {
    const raw = buf; buf = '';
    for (const line of raw.split('\n')) {
      const text = tidy(line);
      if (!text) continue;
      const m = BULLET_LINE.exec(text);
      if (m) blocks.push({ t: 'li', text: text.slice(m[0].length), ordered: /^\d/.test(m[0]), n: parseInt(m[0], 10) || 0 });
      else blocks.push({ t: 'p', text });
    }
  };
  const closeLi = () => {
    if (!inLi) return;
    const text = tidy(buf); buf = ''; inLi = false;
    if (text) blocks.push({ t: 'li', text, ordered: liOrdered, n: liN });
  };

  const tokens = cleaned.match(/<\/?[a-zA-Z][^>]*>|[^<]+|</g) || [];
  for (const tok of tokens) {
    if (tok[0] !== '<' || tok.length === 1) { buf += decode(tok).replace(/[\r\t ]+/g, ' ').replace(/\n+/g, inLi || heading ? ' ' : '\n'); continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tok); if (!m) continue;
    const closing = m[1] === '/', tag = m[2].toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      if (!closing) { closeLi(); flushParagraph(); heading = Number(tag[1]); }
      else if (heading) { const text = tidy(buf).replace(/\*\*/g, ''); buf = ''; if (text) blocks.push({ t: 'h', text, level: heading }); heading = null; }
    } else if (tag === 'li') {
      if (!closing) { closeLi(); flushParagraph(); inLi = true; const top = lists[lists.length - 1]; liOrdered = !!top?.ordered; liN = top ? ++top.n : 0; }
      else closeLi();
    } else if (tag === 'ul' || tag === 'ol') {
      closeLi(); flushParagraph();
      if (!closing) lists.push({ ordered: tag === 'ol', n: 0 }); else lists.pop();
    } else if (tag === 'br') {
      if (inLi || heading) buf += ' '; else buf += '\n';
    } else if (tag === 'hr') {
      closeLi(); flushParagraph(); blocks.push({ t: 'hr' });
    } else if (tag === 'b' || tag === 'strong') {
      buf += '**';
    } else if (tag === 'i' || tag === 'em') {
      // italics add clutter in embeds — keep the text only
    } else if (tag === 'img') {
      if (!closing) { const src = /src\s*=\s*["']([^"']+)["']/i.exec(tok); if (src) images.push(decode(src[1])); }
    } else if (tag === 'td' || tag === 'th') {
      if (closing) buf += ' | ';
    } else if (BLOCK_TAGS.has(tag)) {
      if (tag === 'tr' && closing) buf = buf.replace(/\s*\|\s*$/, '');
      if (!inLi && !heading) flushParagraph();
    }
  }
  closeLi(); flushParagraph();
  return { blocks, images };
}

/** Raw patch text of any kind → blocks. */
function toBlocks(raw, kind = 'auto') {
  const text = String(raw ?? '');
  if (!text.trim()) return { blocks: [], images: [] };
  const looksHtml = /<(p|div|br|ul|ol|li|h[1-6]|img|a|table)\b/i.test(text);
  const looksBb   = new RegExp(`\\[\\/?(?:${BB_NAMES}|\\*)(?:=[^\\]]*)?\\]`, 'i').test(text);
  let html = text;
  if (kind === 'bbcode' || (kind === 'auto' && looksBb)) html = bbcodeToHtml(text);
  else if (!(kind === 'html' || looksHtml)) html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return htmlToBlocks(html);
}

// ── Blocks → card ─────────────────────────────────────────────────────────────

const CATS = [
  ['fixes',     /\b(fix(?:es|ed)?|bug|bugs|issue|issues|resolved|crash)\b/i,      'fix'],
  ['balance',   /\b(balance|nerf|buff|tuning|adjust)/i,                           'balance change'],
  ['additions', /\b(added|adds|addition|introduc\w*|now available|new (?:feature|content|mode|map|item|skin|agent|champion|weapon)s?)\b/i, 'addition'],
  ['changes',   /\b(change|changes|update|updated|improv|tweak|rework|general)/i, 'change'],
];
const catOf = (text) => (CATS.find(([, re]) => re.test(text)) || [])[0] || null;
/** An item is classified by how it STARTS ("Fixed an issue…"), not by words later in the sentence ("…once the fix is complete"). */
const leadWords = (text) => String(text).split(/\s+/).slice(0, 6).join(' ');

/** Group blocks into { intro:[], sections:[{name, items:[{text,ordered}], lines:[]}] } */
function structure(blocks) {
  const intro = [], sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.t === 'hr') { cur = null; continue; }
    if (b.t === 'h') { cur = { name: b.text, items: [], lines: [] }; sections.push(cur); continue; }
    if (b.t === 'li') {
      if (!cur) { cur = { name: 'Changes', items: [], lines: [], implicit: true }; sections.push(cur); }
      cur.items.push({ text: b.text, ordered: b.ordered });
    } else if (b.t === 'p') {
      if (!cur) intro.push(b.text);
      else cur.lines.push(b.text);
    }
  }
  const out = sections.filter(s => s.items.length || s.lines.length);
  for (const s of out) {
    if (s.implicit && s.items.length) {
      const fixes = s.items.filter(i => CATS[0][1].test(leadWords(i.text))).length;
      s.name = fixes / s.items.length >= 0.6 ? 'Fixes' : 'Changes';
    }
  }
  return { intro, sections: out };
}

function describeCounts(sections) {
  const tally = {}; let total = 0;
  for (const s of sections) {
    const headCat = s.implicit ? null : catOf(s.name);
    const items = s.items.length ? s.items.map(i => i.text) : (s.lines.length ? [s.lines.join(' ')] : []);
    for (const text of items) {
      total++;
      const cat = headCat || catOf(leadWords(text));
      if (cat) tally[cat] = (tally[cat] || 0) + 1;
    }
  }
  if (!total) return '';
  const label = { fixes: ['fix', 'fixes'], balance: ['balance change', 'balance changes'], additions: ['addition', 'additions'], changes: ['change', 'changes'] };
  const parts = Object.entries(tally).filter(([k]) => k !== 'changes').map(([k, v]) => `${v} ${label[k][v === 1 ? 0 : 1]}`);
  return `**${total} change${total === 1 ? '' : 's'}**${parts.length ? ' · ' + parts.join(' · ') : ''}`;
}

const bulletLine = (item, i, max = 150) => `${item.ordered ? `${i + 1}.` : '•'} ${truncate(item.text, max)}`;

/**
 * Build the Discord message for one update.
 * @param {object} u  { game, source, title, url, body, bodyKind, image, icon, date, version, color, buttons }
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildUpdateCard(u) {
  const { blocks, images } = toBlocks(u.body, u.bodyKind || 'auto');
  const { intro, sections } = structure(blocks);
  const image = u.image || images.find(x => /^https?:\/\//.test(x)) || null;

  const embed = new EmbedBuilder().setColor(u.color || 0x1B6FA8);
  embed.setAuthor({ name: truncate(`${u.game}${u.source ? ` · ${u.source}` : ''}`, 250), ...(u.icon ? { iconURL: u.icon } : {}) });
  if (u.title) embed.setTitle(truncate(u.title, 250));
  if (u.url) embed.setURL(u.url);

  const summary = describeCounts(sections);
  const lead = intro.find(p => p.length > 25 && !BULLET_LINE.test(p)) || intro[0] || '';
  const desc = [lead ? truncate(lead, 320) : '', summary].filter(Boolean).join('\n\n');
  if (desc) embed.setDescription(desc);

  // Sections → fields, within Discord's limits (4096 desc, 1024 per field, ~6000 total)
  let budget = 3200;
  const MAX_FIELDS = 5, PER = 5;
  const shown = sections.slice(0, MAX_FIELDS);
  for (const s of shown) {
    if (budget < 250) break;
    let value;
    if (s.items.length) {
      const lines = s.items.slice(0, PER).map((it, i) => bulletLine(it, i, 150));
      const more = s.items.length - PER;
      value = lines.join('\n') + (more > 0 ? `\n*…and ${more} more*` : '');
    } else {
      value = truncate(s.lines.slice(0, 2).join('\n'), 400);
    }
    value = truncate(value, 1000);
    embed.addFields({ name: truncate(s.name, 120), value, inline: false });
    budget -= value.length + s.name.length;
  }
  const hidden = sections.length - shown.length;
  if (hidden > 0) embed.addFields({ name: '​', value: `*…plus ${hidden} more section${hidden === 1 ? '' : 's'} in the full notes*`, inline: false });

  if (!embed.data.description && !embed.data.fields?.length) embed.setDescription('*Open the full notes to read this update.*');
  if (image) embed.setImage(image);          // game image at the bottom
  embed.setFooter({ text: [u.source, u.version ? `build ${u.version}` : null].filter(Boolean).join(' · ') || 'Game update' });
  if (u.date) embed.setTimestamp(new Date(u.date));

  const buttons = [];
  if (u.url) buttons.push(new ButtonBuilder().setLabel('Read full notes').setStyle(ButtonStyle.Link).setURL(u.url));
  for (const b of (u.buttons || []).slice(0, 4)) buttons.push(new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url));
  return { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] };
}

module.exports = { decode, truncate, bbcodeToHtml, htmlToBlocks, toBlocks, structure, describeCounts, buildUpdateCard };
