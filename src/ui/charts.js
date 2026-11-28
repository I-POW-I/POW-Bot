/**
 * Small charts drawn into the cards: busy times by hour and a month-by-month bar chart. Same dark style as the cards.
 * Each returns a PNG buffer to attach to an embed's image.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { ensureFonts } = require('./render');

const W = 1000, H = 290;
const LOW = '#6b74ff', HIGH = '#ff7ac6', MUTED = '#8b93a1', GRID = '#2b2d33';

function frame() {
  ensureFonts();
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b1d23'; ctx.beginPath(); ctx.roundRect(0, 0, W, H, 28); ctx.fill();
  return { canvas, ctx };
}

function bars(ctx, values, labels, { highlight = -1, labelEvery = 1, left = 30, right = 30, top = 40, bottom = 64, unit = '' } = {}) {
  const max = Math.max(1e-9, ...values);
  const plotW = W - left - right, plotH = H - top - bottom, n = values.length, slot = plotW / n, bw = slot * 0.62;
  ctx.strokeStyle = GRID; ctx.lineWidth = 2;
  for (const f of [0.5, 1]) { const y = top + plotH * (1 - f); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - right, y); ctx.stroke(); }
  values.forEach((v, i) => {
    const h = Math.max(v > 0 ? 6 : 0, (v / max) * plotH), x = left + i * slot + (slot - bw) / 2, y = top + plotH - h;
    const g = ctx.createLinearGradient(0, y, 0, top + plotH);
    if (i === highlight) { g.addColorStop(0, HIGH); g.addColorStop(1, '#c0408f'); } else { g.addColorStop(0, LOW); g.addColorStop(1, '#3a41a8'); }
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x, y, bw, h, 8); ctx.fill();
    if (i === highlight && v > 0) { ctx.fillStyle = '#fff'; ctx.font = '700 28px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${unit}`, x + bw / 2, y - 12); }
  });
  ctx.fillStyle = MUTED; ctx.font = '600 26px Inter, sans-serif'; ctx.textAlign = 'center';
  labels.forEach((l, i) => { if (i % labelEvery === 0) ctx.fillText(l, left + i * slot + slot / 2, H - bottom + 38); });
}

/** 24 bars, one per hour (UTC). `values` are average people in voice; `now` is the hour to highlight. */
function busyChart(values, now, nowLabel = '', label = 'UTC') {
  const { canvas, ctx } = frame();
  ctx.fillStyle = MUTED; ctx.font = '600 24px Inter, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`PEOPLE IN VOICE BY HOUR (${label})`, 30, 34);
  bars(ctx, values, Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), { highlight: now, labelEvery: 3, top: 60, unit: nowLabel });
  return canvas.encode('png');
}

/** 12 bars, one per month. */
function monthChart(values, title = 'ACTIVITY BY MONTH', highlight = -1) {
  const { canvas, ctx } = frame();
  ctx.fillStyle = MUTED; ctx.font = '600 24px Inter, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(title, 30, 34);
  bars(ctx, values, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], { highlight, top: 60 });
  return canvas.encode('png');
}

module.exports = { busyChart, monthChart };
