/**
 * Kick.com platform wrapper — unofficial API.
 * Kick blocks many cloud hosting IPs. If 403s persist this is an IP issue
 * on Kick's end, not a code issue. Errors are throttled to avoid log spam.
 */

const HEADERS = {
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

async function getStreamStatus(username) {
  const name = username.toLowerCase();

  // Try v2 first, fall back to v1
  for (const url of [
    `https://kick.com/api/v2/channels/${name}`,
    `https://kick.com/api/v1/channels/${name}`,
  ]) {


    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal:  AbortSignal.timeout(10000),



      });

      if (res.status === 403 || res.status === 429) return { error: res.status };




      if (!res.ok) continue;

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;

      const body = await res.json();
      const isLive      = !!body.livestream;
      const stream      = body.livestream;




      const displayName = body.user?.username || body.slug || username;


      return {
        isLive,
        title:       isLive ? stream.session_title || 'Untitled Stream' : null,
        category:    isLive ? (stream.categories?.[0]?.name || null) : null,
        viewers:     isLive ? (stream.viewer_count ?? 0) : null,
        thumbnail:   isLive ? (stream.thumbnail?.url || null) : null,
        url:         `https://kick.com/${name}`,
        displayName,
      };
    } catch { continue; }



  }

  return null;
}

module.exports = { getStreamStatus };
