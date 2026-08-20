/**
 * Kick.com platform wrapper — Safe Web Unlocking Proxy Engine.
 * Bypasses Discloud host blocks by routing requests through a resilient open API proxy.
 */

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  // 🌐 Patched API Route: Using an updated, active public proxy bypass link
  const targetUrl = `https://vercel.app{name}`;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000), // Hard limit to stop Discloud from locking up
    });

    // Handle Cloudflare bans gracefully
    if (res.status === 403 || res.status === 429) {
      return { error: res.status };
    }
    
    if (!res.ok) return null;

    const body = await res.json();
    
    // Support both proxy formats (nested under 'data' or root level)
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
    // Soft log to keep your Discloud log stream clean
    console.error(`[KICK TRACKER ENGINE] Connection skipped for ${name}: proxy route failed.`);
    return null;
  }
}

module.exports = { getStreamStatus };
