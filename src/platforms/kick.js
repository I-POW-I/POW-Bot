/**
 * Kick.com platform wrapper — Unofficial Cloudflare-Bypassed Proxy Engine.
 * Route calls through community mirrors to bypass hosting IP blocks on Discloud.
 */

async function getStreamStatus(username) {
  const name = username.toLowerCase();

  // 🌐 Utilizing public proxy mirrors that provide full Cloudflare clearance
  const urls = [
    `https://kickapi.com{name}`,
    `https://kickapi.com{name}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000), // Protect Discloud memory leak vectors
      });

      // Catch blocking events safely
      if (res.status === 403 || res.status === 429) {
        return { error: res.status };
      }
      
      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) continue;

      const body = await res.json();
      
      // Safety checks: ensure payload features valid user/slug values
      if (!body || (!body.user && !body.slug)) continue;

      const isLive = !!body.livestream;
      const stream = body.livestream;
      const displayName = body.user?.username || body.slug || username;

      // 🎯 Return formatted data mapping matching your existing notification engine requirements
      return {
        isLive,
        title:       isLive ? stream.session_title || 'Untitled Stream' : null,
        category:    isLive ? (stream.categories?.[0]?.name || null) : null,
        viewers:     isLive ? (stream.viewer_count ?? 0) : null,
        thumbnail:   isLive ? (stream.thumbnail?.url || null) : null,
        url:         `https://kick.com/${name}`,
        displayName,
      };
    } catch (err) {
      // Quietly fall back to the next proxy option if the mirror experiences downtime
      continue;
    }
  }

  return null;
}

module.exports = { getStreamStatus };
