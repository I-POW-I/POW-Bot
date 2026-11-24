/**
 * Welcome / leave card generator.
 * Uses @napi-rs/canvas — prebuilt Linux x64 binaries, works on Discloud.
 *
 * Design:
 *   - Transparent background (floats on Discord's dark chat)
 *   - Large circular avatar centered
 *   - Bold username text below avatar
 *   - Smaller subtitle line beneath that
 */

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const W        = 640;  // Canvas width
const H        = 350;  // Canvas height (room under the subtitle for the panel styles)
const AVATAR_R = 96;   // Avatar radius (192px diameter)
const AVATAR_X = W / 2;
const AVATAR_Y = 130;

async function fetchAvatar(url) {
  // Force PNG format for consistency
  const pngUrl = url.split('?')[0] + '?size=512&format=png';
  const res    = await fetch(pngUrl, { signal: AbortSignal.timeout(10000) });
  return Buffer.from(await res.arrayBuffer());
}

/** '#RRGGBB' -> 'rgba(r,g,b,a)' */
function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const PANELS = {
  midnight: ['#1b1f3b', '#0b0d1c'],
  aurora:   ['#3a1c71', '#168a9a'],
  sunset:   ['#b3345f', '#e8803a'],
  graphite: ['#2f3136', '#1e1f22'],
};

/** A rounded rectangle path. */
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The outline of the avatar: a circle or a rounded square of the same size. */
function avatarPath(ctx, grow, shape) {
  if (shape === 'rounded') roundedRect(ctx, AVATAR_X - AVATAR_R - grow, AVATAR_Y - AVATAR_R - grow, (AVATAR_R + grow) * 2, (AVATAR_R + grow) * 2, 36 + grow);
  else { ctx.beginPath(); ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + grow, 0, Math.PI * 2); }
}

/** Panel behind the card for the built-in styles. Classic draws nothing (transparent). */
function drawPanel(ctx, style, accent, isLeave) {
  const colours = PANELS[style];
  if (!colours) return;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, colours[0]); g.addColorStop(1, colours[1]);
  roundedRect(ctx, 2, 2, W - 4, H - 4, 28);
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.stroke();
  if (style === 'midnight') {   // an accent edge down the left side
    ctx.save(); roundedRect(ctx, 2, 2, W - 4, H - 4, 28); ctx.clip();
    ctx.fillStyle = accent || (isLeave ? '#747F8D' : '#5865F2'); ctx.fillRect(0, 0, 10, H);
    ctx.restore();
  }
}

/**
 * Generate a welcome or leave card.
 * @param {'welcome'|'leave'} type
 * @param {string}  displayName  Member's display name
 * @param {string}  avatarUrl    Discord avatar URL
 * @param {number}  memberCount  Guild member count
 * @param {{ title?: string, subtitle?: string, accent?: string|null, style?: string, shape?: string }} [opts]  Server-customised text, colour and look
 * @returns {Buffer}  PNG image buffer
 */
async function generateCard(type, displayName, avatarUrl, memberCount, opts = {}) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const isLeave = type === 'leave';
  const accent  = /^#[0-9a-f]{6}$/i.test(opts.accent || '') ? opts.accent : null;
  const titleText = opts.title || displayName;
  const subtitleText = opts.subtitle !== undefined ? opts.subtitle : (isLeave ? `${displayName} has left the server` : '');

  // Classic is transparent; the other styles draw a panel first
  const shape = opts.shape === 'rounded' ? 'rounded' : 'circle';
  drawPanel(ctx, opts.style, accent, isLeave);

  // ── Avatar ──────────────────────────────────────────────────────────────────

  // Subtle shadow ring so avatar stands out against dark backgrounds
  ctx.save();
  ctx.shadowColor = accent ? rgba(accent, 0.6) : isLeave ? 'rgba(100,100,100,0.5)' : 'rgba(88,101,242,0.6)';
  ctx.shadowBlur  = 28;
  avatarPath(ctx, 2, shape);
  ctx.strokeStyle = accent ? rgba(accent, 0.9) : isLeave ? 'rgba(120,120,120,0.8)' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = 3;
  ctx.stroke();
  ctx.restore();

  try {
    const buf = await fetchAvatar(avatarUrl);
    const img = await loadImage(buf);

    // Clip avatar to circle
    ctx.save();
    avatarPath(ctx, 0, shape);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    ctx.restore();



  } catch {
    // Fallback: plain coloured circle if avatar fails to load
    avatarPath(ctx, 0, shape);
    ctx.fillStyle = accent || (isLeave ? '#747F8D' : '#5865F2');
    ctx.fill();
  }

  // ── Username ──────────────────────────────────────────────────────────────────
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Shrink long text to fit, then truncate as a last resort
  let size = 50;
  ctx.font = `bold ${size}px sans-serif`;
  while (size > 26 && ctx.measureText(titleText).width > W - 60) { size -= 2; ctx.font = `bold ${size}px sans-serif`; }
  let name = titleText;
  while (name.length > 1 && ctx.measureText(name).width > W - 60) {
    name = name.slice(0, -1);
  }
  if (name !== titleText) name += '…';

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur  = 6;
  ctx.fillText(name, W / 2, AVATAR_Y + AVATAR_R + 44);
  ctx.shadowBlur  = 0;

  // ── Subtitle (leave cards by default; any card when the server sets one) ──
  if (subtitleText) {
    ctx.font      = '22px sans-serif';
    ctx.fillStyle = '#9ca3af';

    const subtitle = subtitleText;

    // Truncate subtitle too
    let sub = subtitle;
    while (sub.length > 1 && ctx.measureText(sub).width > W - 80) {
      sub = sub.slice(0, -1);
    }
    if (sub !== subtitle) sub += '…';

    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur  = 4;
    ctx.fillText(sub, W / 2, AVATAR_Y + AVATAR_R + 82);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateCard, STYLE_KEYS: ['classic', ...Object.keys(PANELS)] };
