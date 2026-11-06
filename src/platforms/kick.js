/**
 * Kick.com platform wrapper.
 *
 * OFFICIAL API (recommended — works from hosting providers like Discloud):
 *   1. Go to your Kick account settings → Developer, and create an app.
 *   2. Copy the Client ID and Client Secret.
 *   3. Set KICK_CLIENT_ID and KICK_CLIENT_SECRET in your Discloud variables.
 *
 * Uses an app access token (client-credentials grant) and
 *   GET https://api.kick.com/public/v1/channels?slug=<channel>
 *
 * The old unofficial kick.com/api endpoints sit behind Cloudflare, which blocks
 * most cloud/hosting IPs (403, or an HTML challenge page that looks like "no
 * data") — that's why notifications silently stopped. Without credentials this
 * module still falls back to them so nothing breaks, but expect it to fail.
 */

const { log } = require('../logger');

const apiUrl   = () => process.env.KICK_API_URL   || 'https://api.kick.com';
const oauthUrl = () => process.env.KICK_OAUTH_URL || 'https://id.kick.com';

const hasCredentials = () => !!(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);

// ── App access token ──────────────────────────────────────────────────────────

let accessToken    = null;
let tokenExpiresAt = 0;
let tokenFailed    = false;   // wrong Client ID/Secret — stop hammering until restart
let tokenPromise   = null;    // de-duplicates concurrent refreshes

async function fetchToken() {
  const res = await fetch(`${oauthUrl()}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 400 || res.status === 401) {
    tokenFailed = true;
    throw new Error(`Kick credentials rejected (${res.status}) — check KICK_CLIENT_ID and KICK_CLIENT_SECRET`);
  }
  if (!res.ok) throw new Error(`Kick token endpoint returned ${res.status}`);

  const data = await res.json();
  if (!data.access_token) throw new Error('Kick token response missing access_token');

  accessToken    = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  tokenFailed    = false;
  return accessToken;
}

async function getToken(force = false) {
  if (tokenFailed) throw new Error('Kick credentials invalid — check KICK_CLIENT_ID and KICK_CLIENT_SECRET');
  if (!force && accessToken && Date.now() < tokenExpiresAt - 5 * 60_000) return accessToken;
  if (!tokenPromise) tokenPromise = fetchToken().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

// ── Official API ──────────────────────────────────────────────────────────────

async function officialGet(path) {
  const request = (token) => fetch(`${apiUrl()}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal:  AbortSignal.timeout(10_000),
  });

  let res = await request(await getToken());
  if (res.status === 401) res = await request(await getToken(true));   // token revoked/expired early
  return res;
}

let warnedShape = false;

async function getStreamStatusOfficial(username) {
  const slug = username.toLowerCase();

  try {
    const res = await officialGet(`/public/v1/channels?slug=${encodeURIComponent(slug)}`);

    if (res.status === 429 || res.status === 403) return { error: res.status };
    // Kick answers 400 for a slug that doesn't exist
    if (res.status === 400 || res.status === 404) return { error: `channel "${slug}" not found on Kick — check the username` };
    if (!res.ok) return { error: `Kick API returned ${res.status}` };

    const body = await res.json();
    const ch   = Array.isArray(body?.data) ? body.data[0] : null;

    if (!ch) {
      if (!Array.isArray(body?.data) && !warnedShape) {
        warnedShape = true;
        log('WARN', 'Kick: unexpected API response shape', { keys: Object.keys(body || {}).join(',') || '(empty)' });
      }
      return { error: `channel "${slug}" not found on Kick` };
    }

    const stream = ch.stream || {};
    const isLive = !!stream.is_live;
    const thumb  = typeof stream.thumbnail === 'string' ? stream.thumbnail : stream.thumbnail?.url;

    return {
      isLive,
      title:       isLive ? (ch.stream_title || 'Untitled Stream') : null,
      category:    isLive ? (ch.category?.name || null) : null,
      viewers:     isLive ? (stream.viewer_count ?? 0) : null,
      thumbnail:   isLive ? (thumb || null) : null,
      url:         `https://kick.com/${ch.slug || slug}`,
      displayName: ch.slug || username,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Legacy unofficial API (fallback when no credentials are configured) ───────

const LEGACY_HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':           'application/json, text/plain, */*',
  'Accept-Language':  'en-US,en;q=0.9',
  'Accept-Encoding':  'gzip, deflate, br',
  'Referer':          'https://kick.com/',
  'Origin':           'https://kick.com',
  'Sec-Fetch-Dest':   'empty',
  'Sec-Fetch-Mode':   'cors',
  'Sec-Fetch-Site':   'same-origin',
  'Cache-Control':    'no-cache',
};

async function getStreamStatusLegacy(username) {
  const name = username.toLowerCase();

  // Try v2 first, fall back to v1
  for (const url of [
    `https://kick.com/api/v2/channels/${name}`,
    `https://kick.com/api/v1/channels/${name}`,
  ]) {
    try {
      const res = await fetch(url, { headers: LEGACY_HEADERS, signal: AbortSignal.timeout(10_000) });

      if (res.status === 403 || res.status === 429) return { error: res.status };
      if (!res.ok) continue;

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;

      const body   = await res.json();
      const stream = body.livestream;
      const isLive = !!stream;

      return {
        isLive,
        title:       isLive ? stream.session_title || 'Untitled Stream' : null,
        category:    isLive ? (stream.categories?.[0]?.name || null) : null,
        viewers:     isLive ? (stream.viewer_count ?? 0) : null,
        thumbnail:   isLive ? (stream.thumbnail?.url || null) : null,
        url:         `https://kick.com/${name}`,
        displayName: body.user?.username || body.slug || username,
      };
    } catch { continue; }
  }

  return { error: 'Kick returned no usable data (blocked by Cloudflare?) — set KICK_CLIENT_ID and KICK_CLIENT_SECRET to use the official API' };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getStreamStatus(username) {
  return hasCredentials() ? getStreamStatusOfficial(username) : getStreamStatusLegacy(username);
}

/** Check credentials at startup and say clearly which mode Kick is running in. */
async function validateCredentials() {
  if (!hasCredentials()) {
    log('WARN', 'Kick: KICK_CLIENT_ID / KICK_CLIENT_SECRET not set — using the unofficial API, which Kick usually blocks on hosting providers');
    return false;
  }
  try {
    await getToken();
    log('INFO', 'Kick credentials validated (official API)');
    return true;
  } catch (err) {
    log('ERROR', `Kick: ${err.message}`);
    return false;
  }
}

module.exports = { getStreamStatus, validateCredentials, hasCredentials };
