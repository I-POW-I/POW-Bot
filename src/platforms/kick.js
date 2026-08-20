/**
 * Kick.com platform wrapper — Resilient Web Unlocking Proxy Engine.
 * Bypasses Cloudflare hosting blocks safely by routing queries through Crawlbase.
 */

// 🛠️ CONFIGURATION: Paste your full "Standard token" inside the quotes below!
const CRAWLBASE_TOKEN = '4KE5-CE7LMu8finknxFWRw';

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  if (!CRAWLBASE_TOKEN || CRAWLBASE_TOKEN.includes('PASTE_YOUR_')) {
    console.warn(`[KICK TRACKER ENGINE] Missing Proxy API Key. Running unstable public mirror fallback for ${name}.`);
  }

  // Construct a bulletproof cloud-bypassing URL via Crawlbase wrapper
  const kickUrl = `https://kick.com{name}`;
  const targetUrl = CRAWLBASE_TOKEN && !CRAWLBASE_TOKEN.includes('PASTE_YOUR_')
    ? `https://crawlbase.com{CRAWLBASE_TOKEN}&url=${encodeURIComponent(kickUrl)}`
    : `https://vercel.app{name}`; // Backup safeguard

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(15000), // Gives the proxy network plenty of time to bypass Cloudflare
    });

    if (res.status === 403 || res.status === 429) {
      console.error(`[KICK TRACKER ENGINE] Proxy returned structural blockage code: ${res.status}`);
      return { error: res.status };
    }
    
    if (!res.ok) return null;

    const body = await res.json();
    
    // Unpack Crawlbase body responses directly
    const data = body.data || body;
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
    console.error(`[KICK TRACKER CRITICAL ERROR] Connection dropped for ${name}: API connection path failed.`);
    return null;
  }
}

module.exports = { getStreamStatus };
