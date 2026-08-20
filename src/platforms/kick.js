/**
 * Kick.com platform wrapper — Safe Web Unlocking Proxy Engine.
 * Formats your connection call strings through specialized rotation proxies.
 */

async function getStreamStatus(username) {
  const name = username.toLowerCase();
  
  // 🛠️ CONFIGURATION: If public mirrors block you, swap targetUrl out with a free Scraper API request link:
  // const targetUrl = `https://scraperapi.com{name}`;
  const targetUrl = `https://kickapi.com{name}`;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(12000), // Drop stalled connection lines early
    });

    if (res.status === 403 || res.status === 429) return { error: res.status };
    if (!res.ok) return null;

    const body = await res.json();
    if (!body || (!body.user && !body.slug)) return null;

    const isLive = !!body.livestream;
    const stream = body.livestream;
    const displayName = body.user?.username || body.slug || username;

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
    console.error(`[KICK TRACKER CRITICAL ERROR] Connection timed out or failed for ${name}:`, err.message);
    return null;
  }
}

module.exports = { getStreamStatus };
