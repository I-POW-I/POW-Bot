/**
 * The card renderer. One look for every message the bot sends: a dark panel with a soft glow in the embed's colour,
 * small-caps labels, bold values, thin dividers. Takes the JSON of a Discord embed and returns a PNG.
 */

const path = require('node:path');
const fs = require('node:fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const rich = require('./richText');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  for (const f of ['Regular', 'Italic', 'SemiBold', 'Bold', 'ExtraBold']) {
    const p = path.join(FONT_DIR, `Inter-${f}.otf`);
    try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, 'Inter'); } catch { /* falls back to sans-serif */ }
  }
  fontsReady = true;
}

const T = {
  bg: '#15161b', border: '#26282d', rule: '#2b2d31', text: '#dbdee1', white: '#ffffff', muted: '#949ba4', label: '#8b93ff',
  pad: 26, scale: 3,
};

const rgba = (n, a) => { const v = Number(n) & 0xFFFFFF; return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; };
const roundRect = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

// ── images ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const remember = (key, val) => { cache.set(key, val); if (cache.size > 300) cache.delete(cache.keys().next().value); return val; };

async function fetchImage(url) {
  if (cache.has(url)) return cache.get(url);
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(url, { signal: ctl.signal }); clearTimeout(timer);
    if (!res.ok) return remember(url, null);
    return remember(url, await loadImage(Buffer.from(await res.arrayBuffer())));
  } catch { return null; }                       // not cached: it may work next time
}

const emojiDir = (() => { try { return path.dirname(require.resolve('@twemoji/svg/package.json')); } catch { return null; } })();
async function emojiImage(name) {
  const key = `tw:${name}`;
  if (cache.has(key)) return cache.get(key);
  if (!emojiDir) return null;
  for (const n of [name, name.replace(/-200d.*$/, '')]) {
    try { return remember(key, await loadImage(fs.readFileSync(path.join(emojiDir, `${n}.svg`)))); } catch { /* try the next name */ }
  }
  return remember(key, null);
}
const customEmojiImage = (id, animated) => fetchImage(`https://cdn.discordapp.com/emojis/${id}.png?size=64${animated ? '' : ''}`);

// ── drawing text lines ───────────────────────────────────────────────────────
async function preload(lines, images) {
  const need = new Map();
  for (const line of lines) for (const it of line.items) {
    const r = it.run;
    if (r.t === 'emoji') need.set(`e:${r.name}`, () => emojiImage(r.name));
    else if (r.t === 'custom') need.set(`c:${r.id}`, () => customEmojiImage(r.id, r.animated));
  }
  await Promise.all([...need].map(async ([k, f]) => images.set(k, await f())));
}

function drawLines(ctx, lines, x0, y0, images, defaultColour) {
  let y = y0;
  for (const line of lines) {
    if (line.codeBlock) {
      ctx.fillStyle = '#1d1f25';
      ctx.fillRect(x0, y, line.width || ctx.__w || 0, line.h);
    }
    const base = y + line.h / 2;
    if (line.quote) { ctx.fillStyle = '#4e5058'; roundRect(ctx, x0, y + 2, 3, line.h - 4, 1.5); ctx.fill(); }
    if (line.bullet) { ctx.font = `700 ${line.size || 15}px Inter, sans-serif`; ctx.fillStyle = line.bulletColour || T.label; ctx.textBaseline = 'middle'; ctx.fillText(line.bullet, x0 + (line.indent || 0) - (ctx.measureText(line.bullet).width + 6), base); }
    // one rounded box behind each mention or channel name, however many pieces it has
    { const size0 = line.size || 15; let g = null;
      const close = () => { if (!g) return; ctx.fillStyle = g.colour ? rgba(parseInt(String(g.colour).replace('#', ''), 16), .2) : 'rgba(139,147,255,.18)'; roundRect(ctx, g.x, base - size0 * .68, g.end - g.x, size0 * 1.36, 5); ctx.fill(); g = null; };
      for (const it of line.items) {
        if (!it.run.pill) { close(); continue; }
        const left = x0 + (line.indent || 0) + it.x - (it.pl || 0), right = x0 + (line.indent || 0) + it.x + it.w + (it.pr || 0);
        if (!g) g = { x: left, end: right, colour: it.run.colour }; else g.end = right;
        if (it.pr) close();
      }
      close(); }
    for (const it of line.items) {
      const r = it.run, x = x0 + (line.indent || 0) + it.x, size = line.size || 15;
      if (r.t === 'emoji' || r.t === 'custom') {
        const img = images.get(r.t === 'emoji' ? `e:${r.name}` : `c:${r.id}`);
        const s = Math.round(size * 1.2);
        if (img) ctx.drawImage(img, x, base - s / 2, s, s);
        continue;
      }
      ctx.font = rich.fontFor(r, size, line.weight || 400);
      ctx.textBaseline = 'middle';
      const w = it.w;
      if (r.code && !line.codeBlock) { ctx.fillStyle = '#23252b'; roundRect(ctx, x - 2, base - size * .72, w + 4, size * 1.44, 4); ctx.fill(); }
      if (r.spoiler) { ctx.fillStyle = '#3a3c43'; roundRect(ctx, x, base - size * .7, w, size * 1.4, 4); ctx.fill(); continue; }
      ctx.fillStyle = r.link ? '#9aa4ff' : r.colour || defaultColour;
      ctx.fillText(r.s, x, base);
      if (r.underline || r.strike) {
        ctx.fillRect(x, r.strike ? base : base + size * .55, ctx.measureText(r.s).width, 1);
      }
    }
    y += line.h;
  }
}

/** Text laid out in two balanced columns inside `fullW`, split between entries where it can be. */
function twoColumns(probe, text, base, fullW, gap) {
  const colW = Math.floor((fullW - gap) / 2);
  const two = rich.layout(probe, text, { ...base, maxW: colW });
  const total = two.height; let best = null, acc = 0;
  two.lines.forEach((l, i) => {
    acc += l.h;
    if (i === two.lines.length - 1) return;
    const cost = Math.max(acc, total - acc) + (two.lines[i + 1].blank || l.blank ? 0 : 60);
    if (!best || cost < best.cost) best = { cost, i };
  });
  if (!best) return null;
  const left = two.lines.slice(0, best.i + 1), right = two.lines.slice(best.i + 1);
  while (left.length && left[left.length - 1].blank) left.pop();
  while (right.length && right[0].blank) right.shift();
  const hh = (a) => a.reduce((n, l) => n + l.h, 0);
  return { lines: left, right, colW, height: Math.max(hh(left), hh(right)) };
}

// ── the card ─────────────────────────────────────────────────────────────────
/**
 * @param {object} embed   an embed's JSON (title, description, fields, author, footer, thumbnail, image, color, url)
 * @param {object} opts    { resolve, attachments: Map(name -> Buffer), width }
 * @returns {Promise<{ png: Buffer, links: {label,url}[], alt: string }>}
 */
async function renderEmbed(embed, opts = {}) {
  ensureFonts();
  const resolve = opts.resolve || (() => null);
  const W = opts.width || (embed.image ? 540 : opts.wide ? 730 : 500);
  const pad = T.pad, inner = W - pad * 2;
  const probe = createCanvas(10, 10).getContext('2d');

  const accent = embed.color ?? 0x5865F2;
  const thumbUrl = embed.thumbnail?.url, imgUrl = embed.image?.url;
  const resolveImg = async (url) => {
    if (!url) return null;
    const m = String(url).match(/^attachment:\/\/(.+)$/);
    if (m) { const buf = opts.attachments?.get(decodeURIComponent(m[1])); return buf ? loadImage(buf).catch(() => null) : null; }
    return fetchImage(url);
  };
  const [thumb, image, authorIcon, footerIcon] = await Promise.all([resolveImg(thumbUrl), resolveImg(imgUrl), resolveImg(embed.author?.icon_url), resolveImg(embed.footer?.icon_url)]);
  const textW = thumb ? inner - 100 : inner;

  const titleL = embed.title ? rich.layout(probe, embed.title, { size: 28, lineH: 34, maxW: textW, weight: 800, colour: T.white, resolve, markdown: false }) : null;
  let descL = embed.description ? rich.layout(probe, embed.description, { size: 17, lineH: 25, maxW: textW, resolve }) : null;
  // wide cards run long text in two columns, so the picture is not tall and narrow
  const colGap = 36;
  if (opts.wide && descL && descL.height > 150) descL = twoColumns(probe, embed.description, { size: 17, lineH: 25, resolve }, textW, colGap) || descL;

  // fields: group inline ones into rows of up to three
  const fieldRows = [];
  let run = [];
  const flush = () => { if (run.length) { fieldRows.push(run); run = []; } };
  for (const f of (embed.fields || [])) {
    if (f.inline) { run.push(f); if (run.length === 3) flush(); } else { flush(); fieldRows.push([f]); }
  }
  flush();
  const gap = 20;
  const rows = fieldRows.map(r => {
    const cols = r.length, colW = r.length === 1 ? inner : Math.floor((inner - gap * (cols - 1)) / cols);
    const cells = r.map(f => {
      const val = String(f.value || '');
      const short = !/\n|<[@#:at]/.test(val) && val.length <= 24 && colW < inner;
      let L = rich.layout(probe, val, short ? { size: 19, lineH: 26, maxW: colW, weight: 700, colour: T.white, resolve } : { size: 16, lineH: 23, maxW: colW, resolve });
      if (opts.wide && !short && colW === inner && L.height > 150) L = twoColumns(probe, val, { size: 16, lineH: 23, resolve }, colW, colGap) || L;
      return { f, L, colW, short };
    });
    return { cells, h: 19 + 4 + Math.max(...cells.map(c => c.L.height)) };
  });

  const kicker = embed.author?.name ? embed.author.name.toUpperCase() : null;
  const footerText = embed.footer?.text || '';

  // height
  let y = pad;
  const kickerH = kicker ? 26 : 0;
  y += kickerH;
  const titleY = y; if (titleL) y += titleL.height + 4;
  const descY = y + (titleL && descL ? 2 : 0); if (descL) y = descY + descL.height;
  const topBlockEnd = Math.max(y, pad + (thumb ? 80 : 0));
  y = topBlockEnd;
  const hasTop = !!(titleL || descL || kicker);
  const fieldsStart = y + (rows.length ? (hasTop ? 0 : 0) : 0);
  let fy = fieldsStart;
  if (rows.length) { fy += hasTop ? 18 : 0; }
  const fieldsTopRule = rows.length && hasTop ? fieldsStart + 8 : null;
  const rowYs = []; for (const r of rows) { rowYs.push(fy); fy += r.h + 14; }
  y = rows.length ? fy - 14 : y;
  let imageBox = null;
  if (image) { const iw = inner, ih = Math.min(360, Math.round(iw * image.height / image.width)); y += 16; imageBox = { y, w: iw, h: ih }; y += ih; }
  let footerY = null;
  if (footerText) { y += 18; footerY = y; y += 16 + 6; }
  const H = Math.min(2400, y + pad);
  if (opts.dry) return { height: H, width: W };

  const canvas = createCanvas(W * T.scale, H * T.scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(T.scale, T.scale);

  // panel
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.fillStyle = T.bg; ctx.fill();
  ctx.save(); roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.clip();
  const g = ctx.createRadialGradient(W - 20, 10, 0, W - 20, 10, 170);
  g.addColorStop(0, rgba(accent, .38)); g.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.stroke();

  const images = new Map();
  await preload([...(titleL?.lines || []), ...(descL?.lines || []), ...(descL?.right || []), ...rows.flatMap(r => r.cells.flatMap(c => [...c.L.lines, ...(c.L.right || [])]))], images);

  // kicker
  if (kicker) {
    let kx = pad;
    if (authorIcon) { ctx.save(); ctx.beginPath(); ctx.arc(kx + 8, pad + 8, 8, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(authorIcon, kx, pad, 16, 16); ctx.restore(); kx += 22; }
    spaced(ctx, kicker.slice(0, 80), kx, pad + 9, '600 11.5px Inter, sans-serif', T.label, 1.5);
  }
  if (titleL) drawLines(ctx, titleL.lines, pad, titleY, images, T.white);
  if (descL) {
    const cw = descL.right ? descL.colW : textW;
    descL.lines.forEach(l => { if (l.codeBlock) l.width = cw; });
    drawLines(ctx, descL.lines, pad, descY, images, T.text);
    if (descL.right) { descL.right.forEach(l => { if (l.codeBlock) l.width = cw; }); drawLines(ctx, descL.right, pad + cw + colGap, descY, images, T.text); }
  }
  if (thumb) { ctx.save(); roundRect(ctx, W - pad - 80, pad, 80, 80, 14); ctx.clip(); const s = Math.max(80 / thumb.width, 80 / thumb.height); ctx.drawImage(thumb, W - pad - 80 + (80 - thumb.width * s) / 2, pad + (80 - thumb.height * s) / 2, thumb.width * s, thumb.height * s); ctx.restore(); }

  if (fieldsTopRule != null) rule(ctx, pad, fieldsTopRule, inner);
  rows.forEach((r, ri) => {
    let x = pad; const ry = rowYs[ri];
    r.cells.forEach((c) => {
      spaced(ctx, String(c.f.name || '').toUpperCase().slice(0, 80), x, ry + 7, '600 11.5px Inter, sans-serif', T.label, 1.3, c.colW);
      const cw = c.L.right ? c.L.colW : c.colW;
      c.L.lines.forEach(l => { if (l.codeBlock) l.width = cw; });
      drawLines(ctx, c.L.lines, x, ry + 23, images, c.short ? T.white : T.text);
      if (c.L.right) { c.L.right.forEach(l => { if (l.codeBlock) l.width = cw; }); drawLines(ctx, c.L.right, x + cw + colGap, ry + 23, images, T.text); }
      x += c.colW + gap;
    });
  });

  if (imageBox) { ctx.save(); roundRect(ctx, pad, imageBox.y, imageBox.w, imageBox.h, 10); ctx.clip(); ctx.drawImage(image, pad, imageBox.y, imageBox.w, imageBox.h); ctx.restore(); }
  if (footerY != null) {
    rule(ctx, pad, footerY - 9, inner);
    let fx = pad;
    if (footerIcon) { ctx.save(); ctx.beginPath(); ctx.arc(fx + 7, footerY + 8, 7, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(footerIcon, fx, footerY + 1, 14, 14); ctx.restore(); fx += 20; }
    ctx.font = '400 13px Inter, sans-serif'; ctx.fillStyle = T.muted; ctx.textBaseline = 'middle';
    const fl = rich.layout(probe, footerText, { size: 13, lineH: 17, maxW: inner - (fx - pad), resolve, markdown: false });
    ctx.fillText(fl.lines[0]?.items.map(i => i.run.s || '').join('') || footerText, fx, footerY + 8);
  }

  const links = [];
  if (embed.url && embed.title) links.push({ label: 'Open', url: embed.url });
  for (const l of [...rich.linksIn(embed.description), ...(embed.fields || []).flatMap(f => rich.linksIn(f.value))]) if (!links.some(x => x.url === l.url)) links.push(l);

  const alt = [embed.author?.name, embed.title, rich.plain(embed.description, resolve), ...(embed.fields || []).map(f => `${f.name}: ${rich.plain(f.value, resolve)}`), embed.footer?.text].filter(Boolean).join('. ').slice(0, 1000);
  return { png: await canvas.encode('png'), links, alt, width: W, height: H };
}

function spaced(ctx, text, x, y, font, colour, spacing, maxW = Infinity) {
  text = rich.plain(text).replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').trim();
  ctx.font = font; ctx.fillStyle = colour; ctx.textBaseline = 'middle';
  const chars = [...text], widths = chars.map(ch => ctx.measureText(ch).width + spacing);
  let total = widths.reduce((a, b) => a + b, 0), n = chars.length;
  if (total > maxW) { const dots = ctx.measureText('…').width + spacing; while (n > 1 && widths.slice(0, n).reduce((a, b) => a + b, 0) + dots > maxW) n--; chars.length = n; chars.push('…'); widths.length = n; widths.push(dots); }
  let cx = x;
  chars.forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i]; });
}
function rule(ctx, x, y, w) { ctx.fillStyle = T.rule; ctx.fillRect(x, y, w, 1); }

/**
 * Discord shows a picture at most about 550 wide and 400 high, shrinking anything bigger. How much a card shrinks is how hard
 * it is to read, so a tall narrow card is drawn again wide (long text in two columns) when that shrinks it less.
 */
const shown = (w, h) => Math.min(1, 550 / w, 400 / h);
async function renderBest(embed, opts = {}) {
  const narrow = await renderEmbed(embed, { ...opts, dry: true });
  let best = { wide: false, scale: shown(narrow.width, narrow.height) };
  if (!embed.image && !opts.width && best.scale < 0.95) {
    const wide = await renderEmbed(embed, { ...opts, wide: true, dry: true });
    const scale = shown(wide.width, wide.height);
    if (scale > best.scale + 0.03) best = { wide: true, scale };
  }
  return { ...(await renderEmbed(embed, { ...opts, wide: best.wide })), scale: best.scale };
}

module.exports = { renderEmbed, renderBest, ensureFonts, T };
