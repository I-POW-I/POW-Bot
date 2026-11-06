/**
 * YouTube Data API v3 wrapper.
 * Requires YOUTUBE_API_KEY in Discloud Variables.
 *
 * Uses RSS feed + videos.list instead of search endpoint.
 * Cost: ~1 quota unit per check vs 100 with search.
 * Free quota: 10,000 units/day — this approach uses ~288/day per channel.
 */

const { log } = require('../logger');

async function ytGet(path) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API 429 — quota exceeded. Resets at midnight Pacific Time. Body: ${body.slice(0, 120)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 120)}`);
  }

  return res.json();
}

/**
 * Resolve a YouTube handle or /c/ path to a channel ID.
 * Costs 1 quota unit — only called once when adding a streamer.
 */
async function resolveHandle(handle) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return null;

    const clean = handle.replace(/^@/, '');

    const byHandle = await ytGet(`channels?part=id&forHandle=${encodeURIComponent(clean)}&key=${apiKey}`);
    if (byHandle.items?.[0]?.id) return byHandle.items[0].id;

    const byUser = await ytGet(`channels?part=id&forUsername=${encodeURIComponent(clean)}&key=${apiKey}`);
    return byUser.items?.[0]?.id || null;
  } catch (err) {
    log('WARN', `YouTube handle resolve failed for ${handle}`, { err });
    return null;
  }
}

/**
 * Fetch channel display name by ID.
 * Costs 1 quota unit — only called when adding a streamer.
 */
async function getDisplayName(channelId) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return null;
    const data = await ytGet(`channels?part=snippet&id=${channelId}&key=${apiKey}`);
    return data.items?.[0]?.snippet?.title || null;
  } catch { return null; }
}

/**
 * Get recent video IDs from a channel's public RSS feed.
 * Costs ZERO quota units — no API key needed.
 * Returns up to 5 most recent video IDs.
 */
async function getRecentVideoIds(channelId) {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { signal: AbortSignal.timeout(10000) }
  );

  if (!res.ok) return [];

  const xml  = await res.text();
  const ids  = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)]
    .map(m => m[1])
    .slice(0, 5); // Only check the 5 most recent

  return ids;
}

/**
 * Get live status for a YouTube channel.
 *
 * Flow:
 *   1. Fetch RSS feed (0 quota units) to get recent video IDs
 *   2. Call videos.list with all IDs in one request (1 quota unit)
 *   3. Check liveBroadcastContent === 'live'
 *
 * Total cost: 1 quota unit per check (vs 100 with search endpoint).
 */
async function getStreamStatus(channelId) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error('YOUTUBE_API_KEY not set');

    // Step 1: Get recent video IDs from RSS (free)
    const videoIds = await getRecentVideoIds(channelId);
    if (videoIds.length === 0) return { isLive: false, displayName: channelId };

    // Step 2: Check all IDs in a single API call (1 unit)
    const data = await ytGet(
      `videos?part=snippet,liveStreamingDetails&id=${videoIds.join(',')}&key=${apiKey}`
    );

    // Find the live video if any
    const liveVideo = data.items?.find(v => v.snippet?.liveBroadcastContent === 'live');
    const isLive    = !!liveVideo;

    // Get display name from any video snippet (saves an extra API call)
    const channelTitle = data.items?.[0]?.snippet?.channelTitle || channelId;

    if (!isLive) {
      return { isLive: false, displayName: channelTitle };
    }

    const viewers   = parseInt(liveVideo.liveStreamingDetails?.concurrentViewers) || 0;
    const thumbnail = liveVideo.snippet?.thumbnails?.maxres?.url
      || liveVideo.snippet?.thumbnails?.high?.url
      || null;

    return {
      isLive:      true,
      title:       liveVideo.snippet?.title || 'Untitled Stream',
      category:    null, // YouTube has no game field
      viewers,
      thumbnail,
      url:         `https://youtube.com/watch?v=${liveVideo.id}`,
      displayName: channelTitle,
    };

  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { getStreamStatus, resolveHandle, getDisplayName };
