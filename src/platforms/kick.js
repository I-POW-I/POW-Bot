/**
 * Kick.com platform wrapper — Resilient Web Unlocking Proxy Engine.
 * Bypasses Cloudflare hosting blocks safely by routing queries through Crawlbase.
 */

// 🛠️ CONFIGURATION: Ensure your full 4KE5 token is pasted inside the single quotes below!
const CRAWLBASE_TOKEN = '4KE5-CE7LMu8finknxFWRw';

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  if (!CRAWLBASE_TOKEN || CRAWLBASE_TOKEN.includes('PASTE_YOUR_')) {
    console.warn(`[KICK TRACKER ENGINE] Missing Proxy API Key. Running unstable public mirror fallback for ${name}.`);
  }

  // 🌐 FIX: Added &format=json to handle API responses correctly via Crawlbase
  const kickUrl = `https://kick.com{name}`;
  const targetUrl = CRAWLBASE_TOKEN && !CRAWLBASE_TOKEN.includes('PASTE_YOUR_')
    ? `https://crawlbase.com{CRAWLBASE_TOKEN}&format=json&url=${encodeURIComponent(kickUrl)}`
    : `https://vercel.app{name}`;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(25000), // ⏳ Increased to 25s because anti-bot processing takes time
    });

    if (res.status === 403 || res.status === 429) {
      console.error(`[KICK TRACKER ENGINE] Proxy returned structural blockage code: ${res.status}`);
      return { error: res.status };
    }
    
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // If Crawlbase fails, log the exact code it gave back to help us debug
      console.warn(`[KICK TRACKER ENGINE] Crawlbase returned status ${res.status} for ${name}`);
      return null;
    }

    const body = await res.json();
    
    // Support nested proxy data structures or direct root objects
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
