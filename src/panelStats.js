/**
 * Numbers for the live voice panel: what happened in voice so far today (UTC), and who is in the bot's call right now.
 * Read from the voice sessions, so a restart loses nothing. Counts people and time only, never anything said.
 */

const { selectAll } = require('./database');

const startOfDay = (now) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

/** Voice time, the most people in voice at once, and how many calls started, since midnight UTC. */
function todayStats(guild, now = Date.now()) {
  const from = startOfDay(now);
  const rows = selectAll(
    `SELECT channel_id, joined_at, COALESCE(left_at, ?) AS end_at FROM vc_sessions
      WHERE guild_id = ? AND COALESCE(summary, 0) = 0 AND channel_id != ? AND COALESCE(left_at, ?) > ? AND joined_at < ?`,
    [now, guild.id, guild.afkChannelId || '', now, from, now + 1]);

  let ms = 0;
  const peakEvents = [], byChannel = new Map();
  for (const r of rows) {
    const start = Math.max(r.joined_at, from), end = Math.min(r.end_at, now);
    if (end <= start) continue;
    ms += end - start;
    peakEvents.push([start, 1], [end, -1]);
    if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, []);
    byChannel.get(r.channel_id).push([r.joined_at, 1], [r.end_at, -1]);
  }

  // at the same moment, people leaving are counted before people arriving
  const order = (a, b) => a[0] - b[0] || a[1] - b[1];
  let now_ = 0, peak = 0;
  for (const [, d] of peakEvents.sort(order)) { now_ += d; if (now_ > peak) peak = now_; }

  // a call starts when a channel goes from empty to occupied
  let calls = 0;
  for (const ev of byChannel.values()) {
    let n = 0;
    for (const [t, d] of ev.sort(order)) { if (d === 1 && n === 0 && t >= from) calls++; n += d; }
  }
  return { ms, peak, calls };
}

/** People in a voice channel, longest in the call first, with when each one joined. */
function inCall(guild, channelId, now = Date.now()) {
  const rows = selectAll(
    'SELECT user_id, MIN(joined_at) AS joined_at FROM vc_sessions WHERE guild_id = ? AND channel_id = ? AND left_at IS NULL GROUP BY user_id ORDER BY joined_at',
    [guild.id, channelId]);
  const since = new Map(rows.map(r => [r.user_id, r.joined_at]));
  const channel = guild.channels.cache.get(channelId);
  const people = [...(channel?.members?.values() || [])].filter(m => !m.user.bot);
  return people
    .map(m => ({ member: m, ms: Math.max(0, now - (since.get(m.id) ?? now)) }))
    .sort((a, b) => b.ms - a.ms);
}

module.exports = { todayStats, inCall, startOfDay };
