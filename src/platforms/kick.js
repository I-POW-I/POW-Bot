/**
 * Kick.com platform wrapper — Resilient Web Unlocking Proxy Engine.
 * Bypasses Cloudflare hosting blocks safely by routing queries through Crawlbase.
 */

// 🔒 Reads your secret token dynamically from Discloud's Environment settings
const CRAWLBASE_TOKEN = process.env.CRAWLBASE_TOKEN;

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  if (!CRAWLBASE_TOKEN) {
    console.warn("[KICK TRACKER ENGINE] Missing Proxy API Key. Running unstable public mirror fallback for " + name);
  }

  // 🌐 Clean destination endpoint on Kick's system
  const kickUrl = "https://kick.com" + name;
  
  // 🌐 FIX: Perfectly structured string builders to guarantee valid URL generation parameters
  let targetUrl = "https://vercel.app" + name;
  
  if (CRAWLBASE_TOKEN && CRAWLBASE_TOKEN.trim() !== "") {
    targetUrl = "https://crawlbase.com" + CRAWLBASE_TOKEN.trim() + "&url=" + encodeURIComponent(kickUrl);
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(30000), // ⏳ 30s limit to allow full browser rendering passes
    });

    if (res.status === 403 || res.status === 429) {
      console.error("[KICK TRACKER ENGINE] Proxy returned structural blockage code: " + res.status);
      return { error: String(res.status) };
    }
    
    if (!res.ok) {
      console.warn("[KICK TRACKER ENGINE] Crawlbase returned status " + res.status + " for " + name);
      return { error: "STATUS_" + res.status };
    }

    const rawText = await res.text();
    if (!rawText) return null;

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error("[KICK TRACKER ENGINE] Failed to parse response data payload from proxy router for " + name);
      return { error: "JSON_PARSE_FAILED" };
    }
    
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
      url:         "https://kick.com/" + name,
      displayName,
    };
  } catch (err) {
    console.error("[KICK TRACKER CRITICAL ERROR] Connection dropped for " + name + ": " + err.message);
    return { error: err.message };
  }
}

module.exports = { getStreamStatus };
