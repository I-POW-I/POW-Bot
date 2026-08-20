/**
 * Kick.com platform wrapper — Resilient Web Unlocking Proxy Engine.
 * Bypasses Cloudflare hosting blocks safely by routing queries through Crawlbase.
 */

// 🔒 Reads your secret token dynamically from Discloud's Environment settings
const CRAWLBASE_TOKEN = process.env.CRAWLBASE_TOKEN;

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  if (!CRAWLBASE_TOKEN) {
    console.warn(`[KICK TRACKER ENGINE] Missing Proxy API Key. Running unstable public mirror fallback for ${name}.`);
  }

  // 🌐 FIX 1: Routing to /scraper instead of root endpoint to activate native proxy browsers
  const kickUrl = `https://kick.com{name}`;
  const targetUrl = CRAWLBASE_TOKEN
    ? `https://crawlbase.com{CRAWLBASE_TOKEN}&url=${encodeURIComponent(kickUrl)}`
    : `https://vercel.app{name}`; // Backup safeguard

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(30000), // ⏳ Increased to 30s to allow full browser rendering pass
    });

    if (res.status === 403 || res.status === 429) {
      console.error(`[KICK TRACKER ENGINE] Proxy returned structural blockage code: ${res.status}`);
      return { error: res.status };
    }
    
    if (!res.ok) {
      console.warn(`[KICK TRACKER ENGINE] Crawlbase returned status ${res.status} for ${name}`);
      return null;
    }

    // 🌐 FIX 2: Read as plain text first to stop raw JSON parsing errors
    const rawText = await res.text();
    if (!rawText) return null;

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error(`[KICK TRACKER ENGINE] Failed to parse response data payload from proxy router for ${name}.`);
      return null;
    }
    
    // Unpack clean data mapping parameters
    const data = body.body ? JSON.parse(body.body) : (body.data || body);
    if (!data || (!data.user && !data.slug)) return null;

    const isLive = !!data.livestream;
    const stream = data.livestream;
    const displayName = data.user?.username || data.slug || username;

    return {
      isLive,
      title:       isLive ? stream.session_title || 'Untitled Stream' : null,
      category:    isLive ? (stream.categories?.[0]?.name || null) : null,
      viewers:     isLive ? (stream.viewer_count ?? 0) : null,
      thumbnail:   isLive ? (stream.thumbnail?.url || null) : null,
      url:         `https://kick.com{name}`,
      displayName,
    };
  } catch (err) {
    console.error(`[KICK TRACKER CRITICAL ERROR] Connection dropped for ${name}: ${err.message}`);
    return null;
  }
}

module.exports = { getStreamStatus };
