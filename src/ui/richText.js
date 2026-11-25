/**
 * Discord-flavoured markdown for the card renderer: parsing into runs, then wrapping runs into lines.
 *
 * Supported: **bold**, *italic* / _italic_, __underline__, ~~strike~~, `code`, ```blocks```, ||spoilers||, [text](url),
 * # headings, -# small text, > quotes, - bullets, 1. lists, <@user> <@&role> <#channel> <t:unix:style>, custom emoji and
 * unicode emoji (drawn from the bundled Twemoji set).
 */

const PILL_PAD = 4;
const MONO = '"DejaVu Sans Mono", "Liberation Mono", monospace';
const EMOJI_RE = /^(?:\p{RI}\p{RI}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/u;

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const LONG_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

/** <t:unix:style> as fixed text. A picture cannot count down, so relative times become dates. */
function timestampText(unix, style) {
  const d = new Date(Number(unix) * 1000);
  if (isNaN(d)) return '?';
  switch (style) {
    case 't': return TIME.format(d);
    case 'T': return `${TIME.format(d)}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
    case 'd': return d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
    case 'D': return SHORT_DATE.format(d);
    case 'F': return `${LONG_DATE.format(d)} ${TIME.format(d)}`;
    case 'R': return relative(d);
    case 'f': default: return `${SHORT_DATE.format(d)} ${TIME.format(d)}`;
  }
}
function relative(d) {
  const s = Math.round((d.getTime() - Date.now()) / 1000), a = Math.abs(s);
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, n] of units) if (a >= n) { const v = Math.floor(a / n); return s < 0 ? `${v} ${name}${v === 1 ? '' : 's'} ago` : `in ${v} ${name}${v === 1 ? '' : 's'}`; }
  return s < 0 ? 'just now' : 'in a moment';
}

/** Twemoji file name for an emoji sequence: lower-case code points, FE0F removed. */
function emojiName(str) {
  const cps = [...str].map(c => c.codePointAt(0));
  const withoutVs = cps.filter(c => c !== 0xFE0F);
  return withoutVs.map(c => c.toString(16)).join('-');
}

/**
 * Inline markdown into runs. `resolve(kind, id)` turns mentions into { text, colour? }.
 * Run: { t:'text', s, bold, italic, strike, underline, code, link, colour, pill } | { t:'emoji', name } | { t:'custom', id, animated }
 */
/**
 * Text the bundled font can draw. Fancy "letters" from the maths block (𝐇𝐞𝐥𝐥𝐨) and full-width forms are turned into
 * ordinary letters; box-drawing and block characters used to decorate channel names are dropped (they would show as boxes).
 */
const DECORATIVE = /[\u2500-\u259F\u25A0-\u25FF\u2800-\u28FF\uE000-\uF8FF\uFFF0-\uFFFF]/gu;
// invisible fillers (Hangul fillers are the usual "blank" channel-name trick), control and unassigned characters, and tag characters
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}\p{Cc}\p{Cn}\p{Co}]/gu;
const clean = (s) => String(s ?? '').replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '').replace(DECORATIVE, '');

function inline(text, resolve = () => null, base = {}, markdown = true) {
  const runs = [];
  const push = (s, style = {}) => { if (s) runs.push({ t: 'text', s, ...base, ...style }); };
  const patterns = [
    { re: /^```[\s\S]*?```/, fn: m => push(m[0].replace(/^```\w*\n?|```$/g, ''), { code: true }) },
    { re: /^`([^`\n]+)`/, fn: m => push(m[1], { code: true }) },
    { re: /^\|\|([\s\S]+?)\|\|/, fn: m => push(m[1], { spoiler: true }) },
    { re: /^\*\*\*([\s\S]+?)\*\*\*/, fn: m => runs.push(...inline(m[1], resolve, { ...base, bold: true, italic: true })) },
    { re: /^\*\*([\s\S]+?)\*\*/, fn: m => runs.push(...inline(m[1], resolve, { ...base, bold: true })) },
    { re: /^__([\s\S]+?)__/, fn: m => runs.push(...inline(m[1], resolve, { ...base, underline: true })) },
    { re: /^~~([\s\S]+?)~~/, fn: m => runs.push(...inline(m[1], resolve, { ...base, strike: true })) },
    { re: /^\*(?!\s)([^*\n]+?)\*(?!\*)/, fn: m => runs.push(...inline(m[1], resolve, { ...base, italic: true })) },
    { re: /^_(?!\s)([^_\n]+?)_(?![\w])/, fn: m => runs.push(...inline(m[1], resolve, { ...base, italic: true })) },
    { re: /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/, fn: m => runs.push(...inline(m[1], resolve, { ...base, link: m[2], underline: true })) },
    { re: /^<@!?(\d+)>/, fn: m => { const r = resolve('user', m[1]); runs.push(...inline(r?.text || '@unknown-user', () => null, { ...base, pill: true, colour: r?.colour })); } },
    { re: /^<@&(\d+)>/, fn: m => { const r = resolve('role', m[1]); runs.push(...inline(r?.text || '@deleted-role', () => null, { ...base, pill: true, colour: r?.colour })); } },
    { re: /^<#(\d+)>/, fn: m => { const r = resolve('channel', m[1]); runs.push(...inline(r?.text || '#deleted-channel', () => null, { ...base, pill: true })); } },
    { re: /^<t:(-?\d+)(?::([tTdDfFR]))?>/, fn: m => push(timestampText(m[1], m[2] || 'f'), base) },
    { re: /^<(a?):\w+:(\d+)>/, fn: m => runs.push({ t: 'custom', id: m[2], animated: m[1] === 'a' }) },
    { re: /^@(everyone|here)\b/, fn: m => push(m[0], { pill: true }) },
    { re: /^https?:\/\/[^\s<>]+/, fn: m => push(m[0], { link: m[0], underline: true }) },
  ];
  let rest = clean(text);
  let plain = '';
  const flush = () => { if (plain) { push(plain); plain = ''; } };
  outer: while (rest.length) {
    if (rest[0] === '\\' && rest.length > 1) { plain += rest[1]; rest = rest.slice(2); continue; }
    const em = rest.match(EMOJI_RE);
    if (em && !/^[0-9#*]$/.test(em[0])) { flush(); runs.push({ t: 'emoji', name: emojiName(em[0]), ...base }); rest = rest.slice(em[0].length); continue; }
    for (const p of markdown ? patterns : []) {
      const m = rest.match(p.re);
      if (m) { flush(); p.fn(m); rest = rest.slice(m[0].length); continue outer; }
    }
    const cp = String.fromCodePoint(rest.codePointAt(0));
    plain += cp; rest = rest.slice(cp.length);
  }
  flush();
  return runs;
}

/** Every [text](url) in a piece of markdown, for link buttons. */
function linksIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) out.push({ label: m[1].replace(/[*_`~|]/g, '').trim(), url: m[2] });
  return out;
}

/** Plain text of markdown, for alt text. */
function plain(text, resolve = () => null) {
  return inline(text, resolve).map(r => r.t === 'text' ? r.s : r.t === 'emoji' ? '' : '').join('').replace(/\s+/g, ' ').trim();
}

const fontFor = (r, size, weight = 400) => {
  if (r.code) return `400 ${Math.round(size * .9)}px ${MONO}`;
  const w = r.bold ? Math.max(weight, 700) : weight;
  return `${r.italic ? 'italic ' : ''}${w} ${size}px Inter, sans-serif`;
};

/**
 * Wrap markdown into drawable lines.
 * opts: { size, lineH, maxW, weight, colour, resolve, markdown }
 * Returns { lines, height }. A line is { items:[{run, x, w}], h, indent, bullet, quote, codeBlock, size }
 */
function layout(ctx, text, opts) {
  const { size = 15, lineH = Math.round(size * 1.5), maxW, weight = 400, colour = '#dbdee1', resolve, markdown = true } = opts;
  const lines = [];
  const src = String(text ?? '').replace(/\r/g, '');
  const rows = [];
  // split into logical rows, keeping fenced blocks together
  const parts = src.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (/^```[\s\S]*```$/.test(part)) { rows.push({ block: part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '') }); continue; }
    for (const l of part.split('\n')) rows.push({ line: l });
  }

  for (const row of rows) {
    if (row.block != null) {
      const bl = row.block.split('\n');
      const w = maxW - 24;
      lines.push({ items: [], h: 6, codeBlock: true, spacer: true });
      for (const raw of bl) {
        const wrapped = wrapRuns(ctx, [{ t: 'text', s: raw.replace(/\t/g, '  ') || ' ', code: true, colour: '#c9cdd4' }], w, size - 1, weight, true);
        for (const w2 of wrapped) lines.push({ items: w2, h: Math.round(size * 1.35), codeBlock: true, indent: 12, size: size - 1 });
      }
      lines.push({ items: [], h: 6, codeBlock: true, spacer: true });
      continue;
    }
    let l = row.line.replace(/^(\s*)└ ?/, '$1› ').replace(/^(\s*)[├│] ?/, '$1› ');
    if (!l.trim()) { lines.push({ items: [], h: Math.round(lineH * 0.45), blank: true }); continue; }
    if (!markdown) { for (const w2 of wrapRuns(ctx, inline(l, resolve, { colour }, false), maxW, size, weight)) lines.push({ items: w2, h: lineH, indent: 0, size, weight }); continue; }

    let sz = size, indent = 0, bullet = null, quote = false, runBase = { colour }, lh = lineH, w = weight;
    let m;
    if ((m = l.match(/^(#{1,3}) (.*)$/))) { sz = [size + 5, size + 3, size + 1][m[1].length - 1]; lh = Math.round(sz * 1.4); runBase = { colour: '#fff', bold: true }; w = 700; l = m[2]; }
    else if ((m = l.match(/^-# (.*)$/))) { sz = size - 2; lh = Math.round(sz * 1.5); runBase = { colour: '#949ba4' }; l = m[1]; }
    else if ((m = l.match(/^> (.*)$/))) { quote = true; indent = 14; l = m[1]; }
    else if ((m = l.match(/^(\s*)[-*•] (.*)$/))) { bullet = '•'; indent = 18 + Math.min(2, Math.floor(m[1].length / 2)) * 16; l = m[2]; }
    else if ((m = l.match(/^(\s*)(\d{1,2})[.)] (.*)$/))) { bullet = `${m[2]}.`; indent = 22 + Math.min(2, Math.floor(m[1].length / 2)) * 16; l = m[3]; }

    const runs = inline(l, resolve, runBase);
    const wrapped = wrapRuns(ctx, runs, maxW - indent, sz, w);
    wrapped.forEach((items, i) => lines.push({ items, h: lh, indent, bullet: i === 0 ? bullet : null, bulletColour: '#8b93ff', quote, size: sz, weight: w }));
  }
  while (lines.length && lines[lines.length - 1].blank) lines.pop();
  return { lines, height: lines.reduce((a, l) => a + l.h, 0) };
}

/** Break runs into lines no wider than maxW. Items carry their own x and width. */
function wrapRuns(ctx, runs, maxW, size, weight, hard = false) {
  const out = [[]];
  let x = 0;
  const cur = () => out[out.length - 1];
  const newline = () => { out.push([]); x = 0; };
  runs.forEach((run, i) => {
    // a mention or channel name is one box, however many runs (text, emoji, text) it is made of; the first and last run carry the padding
    const pl = run.pill && !runs[i - 1]?.pill ? PILL_PAD : 0, pr = run.pill && !runs[i + 1]?.pill ? PILL_PAD : 0;
    if (pl) {                                                  // keep a whole box on one line: move it down if it does not fit here
      let total = pl, j = i;
      for (; j < runs.length && runs[j].pill; j++) {
        if (runs[j].t === 'emoji' || runs[j].t === 'custom') total += Math.round(size * 1.25);
        else { ctx.font = fontFor(runs[j], size, weight); total += ctx.measureText(runs[j].s).width; }
      }
      total += PILL_PAD;
      if (x > 0 && x + total > maxW && total <= maxW) newline();
    }
    if (run.t === 'emoji' || run.t === 'custom') {
      const w = Math.round(size * 1.25);
      if (x + pl + w + pr > maxW && x > 0) newline();
      x += pl; cur().push({ run, x, w, pl, pr }); x += w + (run.pill ? 0 : 1) + pr; return;
    }
    ctx.font = fontFor(run, size, weight);
    const tokens = hard || run.pill ? [run.s] : run.s.split(/(\s+)/).filter(s => s !== '');
    for (const tok of tokens) {
      const isSpace = /^\s+$/.test(tok);
      const w = ctx.measureText(tok).width;
      const lead = tok === tokens[0] ? pl : 0, trail = tok === tokens[tokens.length - 1] ? pr : 0;
      if (isSpace && x === 0) continue;                       // no leading spaces on a wrapped line
      if (x + lead + w + trail > maxW && x > 0 && !isSpace) newline();
      if (w > maxW) {                                         // a word wider than the line: break it by characters
        let chunk = '';
        for (const ch of [...tok]) {
          const cw = ctx.measureText(chunk + ch).width;
          if (cw > maxW && chunk) { cur().push({ run: { ...run, s: chunk }, x, w: ctx.measureText(chunk).width }); newline(); chunk = ch; } else chunk += ch;
        }
        if (chunk) { const cw = ctx.measureText(chunk).width; cur().push({ run: { ...run, s: chunk }, x, w: cw }); x += cw; }
        continue;
      }
      if (isSpace && x + w > maxW) { newline(); continue; }
      x += lead; cur().push({ run: { ...run, s: tok }, x, w, pl: lead, pr: trail }); x += w + trail;
    }
  });
  while (out.length > 1 && !out[out.length - 1].length) out.pop();
  return out;
}

module.exports = { inline, layout, linksIn, plain, fontFor, emojiName, timestampText, MONO };
