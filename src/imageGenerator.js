/**
 * Welcome / leave card generator.
 * Uses @napi-rs/canvas — prebuilt Linux x64 binaries, works on Discloud.
 *
 * Design (unchanged from before):
 *   - Transparent background (floats on Discord's dark chat)
 *   - Large circular avatar
 *   - Bold name text below avatar
 *   - Smaller subtitle line beneath that
 *
 * New: accepts an optional cardConfig (from src/welcomeConfig.js, editable
 * via the dashboard) controlling which name to show, the ring/accent
 * color, and horizontal placement of the avatar and text. Every field is
 * optional — omitting cardConfig entirely reproduces the exact previous
 * behaviour.
 */

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const W        = 640;  // Canvas width
const H        = 320;  // Canvas height
const AVATAR_R = 96;   // Avatar radius (192px diameter)
const AVATAR_Y = 130;

const DEFAULT_ACCENT = { welcome: '#5865F2', leave: '#747F8D' };

const AVATAR_X_BY_POSITION = { left: 150, center: W / 2, right: W - 150 };
const TEXT_X_BY_ALIGN      = { left: 40, center: W / 2, right: W - 40 };

async function fetchAvatar(url) {
  // Force PNG format for consistency
  const pngUrl = url.split('?')[0] + '?size=512&format=png';
  const res    = await fetch(pngUrl, { signal: AbortSignal.timeout(10000) });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate a welcome or leave card.
 * @param {'welcome'|'leave'} type
 * @param {{ nickname: string|null, username: string }} member  Both name forms — cardConfig.nameMode picks which to show, falling back to the other if the chosen one is unavailable
 * @param {string}  avatarUrl    Discord avatar URL
 * @param {number}  memberCount  Guild member count
 * @param {{ nameMode?: 'nickname'|'username', accentColor?: string|null, avatarPosition?: 'left'|'center'|'right', textAlign?: 'left'|'center'|'right' }} [cardConfig]
 * @returns {Buffer}  PNG image buffer
 */
async function generateCard(type, member, avatarUrl, memberCount, cardConfig = {}) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const isLeave = type === 'leave';

  const nameMode       = cardConfig.nameMode === 'username' ? 'username' : 'nickname';
  const avatarPosition = AVATAR_X_BY_POSITION[cardConfig.avatarPosition] !== undefined
    ? cardConfig.avatarPosition : 'center';
  const textAlign      = TEXT_X_BY_ALIGN[cardConfig.textAlign] !== undefined
    ? cardConfig.textAlign : 'center';
  const accent         = cardConfig.accentColor || DEFAULT_ACCENT[isLeave ? 'leave' : 'welcome'];

  const AVATAR_X = AVATAR_X_BY_POSITION[avatarPosition];
  const TEXT_X   = TEXT_X_BY_ALIGN[textAlign];

  const displayName =
    nameMode === 'username'
      ? member.username
      : (member.nickname || member.username);

  // Transparent background — nothing to fill

  // ── Avatar ──────────────────────────────────────────────────────────────────

  // Subtle shadow ring so avatar stands out against dark backgrounds
  ctx.save();
  ctx.shadowColor = isLeave ? 'rgba(100,100,100,0.5)' : hexToRgba(accent, 0.6);
  ctx.shadowBlur  = 28;
  ctx.beginPath();
  ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 2, 0, Math.PI * 2);
  ctx.strokeStyle = isLeave ? 'rgba(120,120,120,0.8)' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = 3;
  ctx.stroke();
  ctx.restore();

  try {
    const buf = await fetchAvatar(avatarUrl);
    const img = await loadImage(buf);

    // Clip avatar to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    ctx.restore();
  } catch {
    // Fallback: plain coloured circle if avatar fails to load
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.fillStyle = isLeave ? '#747F8D' : accent;
    ctx.fill();
  }

  // ── Name ──────────────────────────────────────────────────────────────────
  ctx.textAlign    = textAlign;
  ctx.textBaseline = 'middle';

  // Truncate long names
  ctx.font = 'bold 50px sans-serif';
  let name = displayName;
  while (name.length > 1 && ctx.measureText(name).width > W - 60) {
    name = name.slice(0, -1);
  }
  if (name !== displayName) name += '…';

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur  = 6;
  ctx.fillText(name, TEXT_X, AVATAR_Y + AVATAR_R + 44);
  ctx.shadowBlur  = 0;

  // ── Subtitle ──────────────────────────────────────────────────────────────────
  ctx.font      = '22px sans-serif';
  ctx.fillStyle = isLeave ? '#9ca3af' : '#d1d5db';

  const subtitle = isLeave
    ? `${displayName} has left the server`
    : `You're member #${memberCount.toLocaleString()}`;

  // Truncate subtitle too
  let sub = subtitle;
  while (sub.length > 1 && ctx.measureText(sub).width > W - 80) {
    sub = sub.slice(0, -1);
  }
  if (sub !== subtitle) sub += '…';

  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur  = 4;
  ctx.fillText(sub, TEXT_X, AVATAR_Y + AVATAR_R + 82);

  return canvas.toBuffer('image/png');
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(88,101,242,${alpha})`; // fall back to the old default blue
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

module.exports = { generateCard };
