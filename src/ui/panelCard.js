/**
 * The live voice panel card: server name, where the bot is, who is in the call (with pictures and time), and the day's
 * numbers along the bottom. A fixed layout, drawn with the same fonts and colours as every other card.
 */

const { createCanvas } = require('@napi-rs/canvas');
const rich = require('./richText');
const R = require('./render');
const { T } = R;
const { drawLines, preload, fetchImage, roundRect, rgba, spaced, rule } = R.draw;

const W = 540, PAD = 26, INNER = W - PAD * 2;

function firstLine(probe, text, size, maxW, opts = {}) {
  for (const s of [size, size - 4, size - 8]) {
    const L = rich.layout(probe, text, { size: s, lineH: Math.round(s * 1.25), maxW, markdown: false, colour: T.white, weight: 800, ...opts });
    if (L.lines.length <= 1 || s === size - 8) return { L: { ...L, lines: L.lines.slice(0, 1), height: L.lines[0]?.h || 0 }, size: s };
  }
}
const widthOf = (L) => Math.max(0, ...L.lines.map(l => l.items.reduce((m, it) => Math.max(m, it.x + it.w), 0)));

/**
 * data = { accent, online: { text, colour }, title, subtitle, channelLabel, channel, status: { text, colour },
 *          listTitle, rows: [{ avatar, name, text }], more, stats: [{ name, value }], footer }
 */
async function renderPanel(data, opts = {}) {
  R.ensureFonts();
  const resolve = opts.resolve || (() => null);
  const probe = createCanvas(10, 10).getContext('2d');

  // right-hand block: "Bot is in" over the channel
  const chan = data.channel ? firstLine(probe, data.channel, 19, 230, { weight: 700 }) : null;
  const chanW = chan ? Math.min(230, widthOf(chan.L)) : 0;
  const title = firstLine(probe, data.title, 30, INNER - (chanW ? chanW + 24 : 0));
  const sub = data.subtitle ? rich.layout(probe, data.subtitle, { size: 14, lineH: 20, maxW: INNER - (chanW ? chanW + 24 : 0), colour: T.muted, markdown: false }) : null;
  const subL = sub ? { ...sub, lines: sub.lines.slice(0, 1), height: sub.lines[0]?.h || 0 } : null;

  const stats = data.stats || [];
  const cols = 3, gap = 20, colW = Math.floor((INNER - gap * (cols - 1)) / cols);
  const statRows = [];
  for (let i = 0; i < stats.length; i += cols) {
    const cells = stats.slice(i, i + cols).map(s => ({ s, L: rich.layout(probe, String(s.value), { size: 17, lineH: 22, maxW: colW, weight: 700, colour: T.white, markdown: false, resolve }) }));
    statRows.push({ cells, h: 18 + 2 + Math.max(...cells.map(c => c.L.height)) });
  }

  // heights
  let y = PAD + 8;                                   // top line (online label)
  const titleY = y + 10; y = titleY + Math.max(title.L.height, chan ? 26 : 0);
  const subY = y + 2; if (subL?.height) y = subY + subL.height + 4;
  y += 10; const rule1 = y; y += 12;
  const statusY = y; y += 22;
  const rows = data.rows || [];
  const listLabelY = data.listTitle ? y : null; if (data.listTitle) y += 22;
  y += 4;
  const rowsY = y; y += rows.length * 26;
  const moreY = data.more ? y : null; if (data.more) y += 22;
  if (!rows.length && !data.more) y += 4;
  y += 6; const rule2 = y; y += 14;
  const statsY = y; y += statRows.reduce((n, r) => n + r.h + 12, 0) - (statRows.length ? 12 : 0);
  let footY = null; if (data.footer) { y += 10; footY = y; y += 16; }
  const H = y + PAD - 4;

  if (opts.dry) return { height: H, width: W };

  const canvas = createCanvas(W * T.scale, H * T.scale), ctx = canvas.getContext('2d');
  ctx.scale(T.scale, T.scale);
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.fillStyle = T.bg; ctx.fill();
  ctx.save(); roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.clip();
  const g = ctx.createRadialGradient(W - 20, 10, 0, W - 20, 10, 175);
  g.addColorStop(0, rgba(data.accent ?? 0x5865F2, .38)); g.addColorStop(1, rgba(data.accent ?? 0x5865F2, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 14); ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.stroke();

  const images = new Map();
  const avatars = await Promise.all(rows.map(r => r.avatar ? fetchImage(r.avatar) : null));
  const nameLs = rows.map(r => firstLine(probe, r.name, 15, 150, { weight: 600 }));
  const timeLs = rows.map(r => rich.layout(probe, r.text, { size: 14, lineH: 20, maxW: INNER - 200, colour: T.muted, markdown: false }));
  await preload([...title.L.lines, ...(chan?.L.lines || []), ...nameLs.flatMap(n => n.L.lines), ...stats.length ? statRows.flatMap(r => r.cells.flatMap(c => c.L.lines)) : []], images);

  const dot = (x, y0, colour, r = 4.5) => {
    ctx.fillStyle = rgba(colour, .28); ctx.beginPath(); ctx.arc(x, y0, r + 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `#${(colour & 0xFFFFFF).toString(16).padStart(6, '0')}`; ctx.beginPath(); ctx.arc(x, y0, r, 0, Math.PI * 2); ctx.fill();
  };

  // top line: online label (left), "Bot is in" (right)
  dot(PAD + 5, PAD + 9, data.online.colour);
  spaced(ctx, data.online.text, PAD + 18, PAD + 9, '600 11.5px Inter, sans-serif', T.label, 1.5);
  if (chan) {
    ctx.font = '400 12.5px Inter, sans-serif'; ctx.fillStyle = T.muted; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.fillText(data.channelLabel || 'Bot is in', W - PAD, PAD + 9); ctx.textAlign = 'left';
  }
  drawLines(ctx, title.L.lines, PAD, titleY, images, T.white);
  if (chan) drawLines(ctx, chan.L.lines, W - PAD - chanW, titleY + Math.max(0, (title.L.height - 26) / 2) + 2, images, T.white);
  if (subL?.height) drawLines(ctx, subL.lines, PAD, subY, images, T.muted);
  rule(ctx, PAD, rule1, INNER);

  // status line
  dot(PAD + 5, statusY + 9, data.status.colour, 3.5);
  ctx.font = '600 14px Inter, sans-serif'; ctx.fillStyle = `#${(data.status.colour & 0xFFFFFF).toString(16).padStart(6, '0')}`; ctx.textBaseline = 'middle';
  ctx.fillText(data.status.text, PAD + 18, statusY + 9);
  if (listLabelY != null) spaced(ctx, data.listTitle, PAD, listLabelY + 9, '600 11.5px Inter, sans-serif', T.label, 1.3);

  // people
  rows.forEach((r, i) => {
    const cy = rowsY + i * 26 + 11;
    ctx.save(); ctx.beginPath(); ctx.arc(PAD + 12, cy, 12, 0, Math.PI * 2); ctx.clip();
    if (avatars[i]) ctx.drawImage(avatars[i], PAD, cy - 12, 24, 24);
    else { ctx.fillStyle = '#3a3d52'; ctx.fillRect(PAD, cy - 12, 24, 24); }
    ctx.restore();
    drawLines(ctx, nameLs[i].L.lines, PAD + 36, cy - nameLs[i].L.height / 2, images, T.white);
    drawLines(ctx, timeLs[i].lines, PAD + 200, cy - timeLs[i].height / 2, images, T.muted);
  });
  if (moreY != null) { ctx.font = '400 13.5px Inter, sans-serif'; ctx.fillStyle = T.muted; ctx.textBaseline = 'middle'; ctx.fillText(`+ ${data.more} more`, PAD + 36, moreY + 8); }

  rule(ctx, PAD, rule2, INNER);
  let sy = statsY;
  for (const row of statRows) {
    row.cells.forEach((c, i) => {
      const x = PAD + i * (colW + gap);
      spaced(ctx, String(c.s.name).toUpperCase(), x, sy + 7, '600 11px Inter, sans-serif', T.label, 1.0, colW);
      drawLines(ctx, c.L.lines, x, sy + 20, images, T.white);
    });
    sy += row.h + 12;
  }
  if (footY != null) { ctx.font = '400 12.5px Inter, sans-serif'; ctx.fillStyle = T.muted; ctx.textBaseline = 'middle'; ctx.fillText(data.footer, PAD, footY + 8); }

  const alt = [data.online.text, data.title, data.channel && `${data.channelLabel || 'Bot is in'} ${data.channel}`, data.status.text, ...rows.map(r => `${r.name} ${r.text}`), ...stats.map(s => `${s.name}: ${s.value}`)].filter(Boolean).join('. ').slice(0, 1000);
  return { png: await canvas.encode('png'), links: [], alt, width: W, height: H };
}

const shown = (w, h) => Math.min(1, 550 / w, 400 / h);
async function renderPanelBest(data, opts = {}) {
  const dry = await renderPanel(data, { ...opts, dry: true });
  return { ...(await renderPanel(data, opts)), scale: shown(dry.width, dry.height) };
}

module.exports = { renderPanel, renderPanelBest };
