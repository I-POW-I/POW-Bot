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
const H        = 320;  // Canvas height
const AVATAR_R = 96;   // Avatar radius (192px diameter)
const AVATAR_X = W / 2;
const AVATAR_Y = 130;

async function fetchAvatar(url) {
  // Force PNG format for consistency
  const pngUrl = url.split('?')[0] + '?size=512&format=png';
  const res    = await fetch(pngUrl, { signal: AbortSignal.timeout(10000) });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate a welcome or leave card.
 * @param {'welcome'|'leave'} type
 * @param {string}  displayName  Member's display name
 * @param {string}  avatarUrl    Discord avatar URL
 * @param {number}  memberCount  Guild member count
 * @returns {Buffer}  PNG image buffer
 */
async function generateCard(type, displayName, avatarUrl, memberCount) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const isLeave = type === 'leave';

  // Transparent background — nothing to fill

  // ── Avatar ──────────────────────────────────────────────────────────────────

  // Subtle shadow ring so avatar stands out against dark backgrounds
  ctx.save();
  ctx.shadowColor = isLeave ? 'rgba(100,100,100,0.5)' : 'rgba(88,101,242,0.6)';
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
    ctx.fillStyle = isLeave ? '#747F8D' : '#5865F2';
    ctx.fill();
  }

  // ── Username ──────────────────────────────────────────────────────────────────
  ctx.textAlign    = 'center';
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
  ctx.fillText(name, W / 2, AVATAR_Y + AVATAR_R + 44);
  ctx.shadowBlur  = 0;

  // ── Subtitle (leave cards only — welcome cards no longer show a subtitle) ──
  if (isLeave) {
    ctx.font      = '22px sans-serif';
    ctx.fillStyle = '#9ca3af';

    const subtitle = `${displayName} has left the server`;

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

module.exports = { generateCard };
