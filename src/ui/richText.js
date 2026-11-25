/**
 * Discord-flavoured markdown for the card renderer: parsing into runs, then wrapping runs into lines.
 *
 * Supported: **bold**, *italic* / _italic_, __underline__, ~~strike~~, `code`, ```blocks```, ||spoilers||, [text](url),
 * # headings, -# small text, > quotes, - bullets, 1. lists, <@user> <@&role> <#channel> <t:unix:style>, custom emoji and
 * unicode emoji (drawn from the bundled Twemoji set).
 */

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
function inline(text, resolve = () => null, base = {}) {
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
    { re: /^<@!?(\d+)>/, fn: m => { const r = resolve('user', m[1]); push(r?.text || '@unknown-user', { pill: true, colour: r?.colour }); } },
    { re: /^<@&(\d+)>/, fn: m => { const r = resolve('role', m[1]); push(r?.text || '@deleted-role', { pill: true, colour: r?.colour }); } },
    { re: /^<#(\d+)>/, fn: m => { const r = resolve('channel', m[1]); push(r?.text || '#deleted-channel', { pill: true }); } },
    { re: /^<t:(-?\d+)(?::([tTdDfFR]))?>/, fn: m => push(timestampText(m[1], m[2] || 'f'), base) },
    { re: /^<(a?):\w+:(\d+)>/, fn: m => runs.push({ t: 'custom', id: m[2], animated: m[1] === 'a' }) },
    { re: /^@(everyone|here)\b/, fn: m => push(m[0], { pill: true }) },
    { re: /^https?:\/\/[^\s<>]+/, fn: m => push(m[0], { link: m[0], underline: true }) },
  ];
  let rest = String(text ?? '');
  let plain = '';
  const flush = () => { if (plain) { push(plain); plain = ''; } };
  outer: while (rest.length) {
    if (rest[0] === '\\' && rest.length > 1) { plain += rest[1]; rest = rest.slice(2); continue; }
    const em = rest.match(EMOJI_RE);
    if (em && !/^[0-9#*]$/.test(em[0])) { flush(); runs.push({ t: 'emoji', name: emojiName(em[0]), ...base }); rest = rest.slice(em[0].length); continue; }
    for (const p of patterns) {
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
    if (!markdown) { for (const w2 of wrapRuns(ctx, [{ t: 'text', s: l, colour }], maxW, size, weight)) lines.push({ items: w2, h: lineH, indent: 0, size, weight }); continue; }

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
  for (const run of runs) {
    if (run.t === 'emoji' || run.t === 'custom') {
      const w = Math.round(size * 1.25);
      if (x + w > maxW && x > 0) newline();
      cur().push({ run, x, w }); x += w + 1; continue;
    }
    const pad = run.pill ? 6 : 0;
    ctx.font = fontFor(run, size, weight);
    const tokens = hard ? [run.s] : run.s.split(/(\s+)/).filter(s => s !== '');
    for (const tok of tokens) {
      const isSpace = /^\s+$/.test(tok);
      let w = ctx.measureText(tok).width;
      if (isSpace && x === 0) continue;                       // no leading spaces on a wrapped line
      if (x + w > maxW && x > 0 && !isSpace) newline();
      if (w > maxW) {                                         // a word wider than the line: break it by characters
        let chunk = '';
        for (const ch of [...tok]) {
          const cw = ctx.measureText(chunk + ch).width;
          if (cw > maxW && chunk) { cur().push({ run: { ...run, s: chunk }, x, w: ctx.measureText(chunk).width }); newline(); chunk = ch; } else chunk += ch;
        }
        tok.length && chunk && (cur().push({ run: { ...run, s: chunk }, x, w: ctx.measureText(chunk).width }), x += ctx.measureText(chunk).width);
        continue;
      }
      if (isSpace && x + w > maxW) { newline(); continue; }
      cur().push({ run: { ...run, s: tok }, x, w: w + (run.pill && !isSpace ? pad * 2 : 0), pillPad: run.pill && !isSpace ? pad : 0 });
      x += w + (run.pill && !isSpace ? pad * 2 : 0);
    }
  }
  while (out.length > 1 && !out[out.length - 1].length) out.pop();
  return out;
}

module.exports = { inline, layout, linksIn, plain, fontFor, emojiName, timestampText, MONO };
