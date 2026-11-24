/**
 * Patch-note formatting.
 *
 *   raw text (Steam BBCode, HTML, or plain)  →  blocks  →  a short, readable Discord card
 *
 * Blocks: { t:'h', text, level } · { t:'p', text } · { t:'li', text, ordered, n } · { t:'hr' }
 *
 * The card follows the layout patch-note trackers use: the game name, a linked title, then the notes
 * themselves with large section headings, smaller sub-headings and bullet lists, a small game icon in
 * the corner, and a "Read full notes" button. Long notes are cut at a sentence boundary with a count of
 * what was left out.
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
const tidy = (s) => String(s).replace(/[ \t\u00A0]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\*\*\s*\*\*/g, '').trim();

// ── BBCode (Steam) → HTML ─────────────────────────────────────────────────────

const BB_NAMES = 'p|h[1-6]|b|i|u|s|strike|spoiler|url|img|list|ulist|olist|hr|quote|code|table|tr|th|td|previewyoutube|noparse|center|size|color|font|dynamiclink|sup|sub';

function bbcodeToHtml(input) {
  let s = String(input).replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').replace(/\{STEAM_CLAN_IMAGE\}/g, 'https://clan.fastly.steamstatic.com/images');
  s = s.replace(/\[noparse\]([\s\S]*?)\[\/noparse\]/gi, (_, x) => x.replace(/</g, '&lt;'));
  s = s.replace(/\\([\[\]])/g, '$1');   // Valve escapes brackets with a backslash: \[ MAPS ]

  // A line that is only "[ Maps ]" is a section heading (Valve's patch-note style), not a BBCode tag
  s = s.replace(/^[ \t]*\[\s*([^\[\]\n*]{1,60}?)\s*\][ \t]*$/gm, (line, text) =>
    /^\//.test(text) || new RegExp(`^(?:${BB_NAMES})(?:=|$)`, 'i').test(text.trim()) ? line : `<h2>${text.trim()}</h2>`);

  // The same heading right after a closing tag or before an opening one: "[/list][ MISC ][list]"
  s = s.replace(/(^|\n|\[\/(?:list|ulist|olist|p|h[1-6]|quote|b)\])[ \t]*\[\s*([^\[\]\n*]{1,60}?)\s*\](?=[ \t]*(?:\n|$|\[(?:list|ulist|olist|p|b|h[1-6])\b))/g, (all, before, text) =>
    /^\//.test(text) || new RegExp(`^(?:${BB_NAMES})(?:=|$)`, 'i').test(text.trim()) ? all : `${before}<h2>${text.trim()}</h2>`);

  s = s
    .replace(/\[h([1-6])\]/gi, '<h$1>').replace(/\[\/h([1-6])\]/gi, '</h$1>')
    .replace(/\[(?:b)\]/gi, '<b>').replace(/\[\/b\]/gi, '</b>')
    .replace(/\[(?:i)\]/gi, '<i>').replace(/\[\/i\]/gi, '</i>')
    .replace(/\[p(?:=[^\]]*)?\]/gi, '<p>').replace(/\[\/p\]/gi, '</p>')
    .replace(/\[(?:list|ulist)(?:=[^\]]*)?\]/gi, '<ul>').replace(/\[\/(?:list|ulist)\]/gi, '</ul>')
    .replace(/\[olist\]/gi, '<ol>').replace(/\[\/olist\]/gi, '</ol>')
    .replace(/\[\*\]/g, '<li>').replace(/\[\/\*\]/g, '</li>')
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
      const bold = /^\*\*([^*]{1,70}?)\*\*:?$/.exec(text);
      if (m) blocks.push({ t: 'li', text: text.slice(m[0].length), ordered: /^\d/.test(m[0]), n: parseInt(m[0], 10) || 0, depth: 0 });
      else if (bold) blocks.push({ t: 'h', text: bold[1].trim(), level: 4 });   // a line that is only bold text is a sub-heading
      else blocks.push({ t: 'p', text });
    }
  };
  const closeLi = () => {
    if (!inLi) return;
    const text = tidy(buf); buf = ''; inLi = false;
    if (text) blocks.push({ t: 'li', text, ordered: liOrdered, n: liN, depth: Math.max(0, lists.length - 1) });
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

const ORANGE = 0xF0A030;
const BODY_LIMIT = 3800;     // embed descriptions hold 4096 characters

/** "MAPS" → "Maps"; mixed-case headings and words with digits (CS2) are left alone. */
const headingCase = (text) => {
  const t = String(text).replace(/[:\s]+$/, '').trim();
  if (t !== t.toUpperCase() || !/[A-Z]{3,}/.test(t)) return t;
  return t.split(' ').map(w => (/\d/.test(w) || w.length < 2 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
};

const sameTitle = (a, b) => { const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return !!n(a) && (n(a) === n(b) || n(b).includes(n(a))); };

/**
 * Blocks → Discord markdown: "##" for main sections, "###" for sub-headings, "-" bullets.
 * Stops before BODY_LIMIT and says how many changes were left out.
 */
function renderBody(blocks, title) {
  const list = blocks.slice();
  while (list[0] && (list[0].t === 'hr' || (list[0].t === 'h' && list[0].level === 1 && sameTitle(list[0].text, title)))) list.shift();

  const levels = [...new Set(list.filter(b => b.t === 'h').map(b => b.level))].sort((a, b) => a - b);
  const mark = (level) => (level === levels[0] ? '##' : '###');

  const out = [];
  let used = 0, left = 0, full = false;
  for (const b of list) {
    if (b.t === 'hr') continue;
    let line;
    if (b.t === 'h') line = `${mark(b.level)} ${truncate(headingCase(b.text), 100)}`;
    else if (b.t === 'li') line = `${'  '.repeat(Math.min(b.depth || 0, 2))}${b.ordered && b.n ? `${b.n}.` : '-'} ${truncate(b.text, 220)}`;
    else line = truncate(b.text, 300);

    const gap = b.t === 'h' && out.length ? '\n' : '';
    if (full || used + line.length + gap.length + 1 > BODY_LIMIT) { full = true; if (b.t === 'li') left++; continue; }
    if (gap) out.push('');
    out.push(line); used += line.length + gap.length + 1;
  }
  while (out.length && (/^#{2,3} /.test(out[out.length - 1]) || out[out.length - 1] === '')) out.pop();   // never end on a bare heading
  if (left) out.push('', `*…and ${left} more in the full notes*`);
  return out.join('\n');
}

/**
 * Build the Discord message for one update.
 * @param {object} u  { game, source, title, url, body, bodyKind, image, icon, buttons }
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildUpdateCard(u) {
  const { blocks, images } = toBlocks(u.body, u.bodyKind || 'auto');
  const thumb = u.icon || u.image || images.find(x => /^https?:\/\//.test(x)) || null;

  const embed = new EmbedBuilder().setColor(ORANGE).setAuthor({ name: truncate(u.game || u.source || 'Game update', 250) });
  if (u.title) embed.setTitle(truncate(u.title, 250));
  if (u.url) embed.setURL(u.url);
  embed.setDescription(renderBody(blocks, u.title) || '*Open the full notes to read this update.*');
  if (thumb) embed.setThumbnail(thumb);

  const buttons = [];
  if (u.url) buttons.push(new ButtonBuilder().setLabel('Read full notes').setStyle(ButtonStyle.Link).setURL(u.url));
  for (const b of (u.buttons || []).slice(0, 4)) buttons.push(new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url));
  return { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] };
}

module.exports = { decode, truncate, bbcodeToHtml, htmlToBlocks, toBlocks, renderBody, buildUpdateCard };
