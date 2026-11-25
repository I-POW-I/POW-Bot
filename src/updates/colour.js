/**
 * The main colour of a game's artwork, used for the stripe down the side of its update posts.
 * Looks at a small copy of the picture and picks the most common strong colour (greys, near-black and near-white are
 * ignored). Results are remembered, and any problem returns null so the post falls back to the default colour.
 */

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const cache = new Map();

function toRgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
}

/** Pure part, for tests: RGBA pixel data → 0xRRGGBB or null. */
function pick(data) {
  const BINS = 24, bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max ? d / max : 0;
    if (s < 0.35 || max < 0.3 || (max > 0.97 && s < 0.5)) continue;
    let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = ((h * 60) + 360) % 360;
    const bin = bins[Math.floor(h / (360 / BINS)) % BINS], w = s * max;
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
  }
  const best = bins.reduce((a, c) => (c.w > a.w ? c : a));
  if (best.w <= 0) return null;
  const r = best.r / best.w, g = best.g / best.w, b = best.b / best.w;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60) + 360) % 360) / 360;
  const [R, G, B] = toRgb(h, Math.max(0.55, Math.min(1, max ? d / max : 0)), Math.max(0.75, max));   // bright enough to see on a dark background
  return (R << 16) | (G << 8) | B;
}

async function dominantColour(url) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);
  let colour = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const img = await loadImage(Buffer.from(await res.arrayBuffer()));
      const canvas = createCanvas(32, 32), ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      colour = pick(ctx.getImageData(0, 0, 32, 32).data);
    }
  } catch { /* no colour: the default is used */ }
  cache.set(url, colour);
  return colour;
}

module.exports = { dominantColour, pick };
