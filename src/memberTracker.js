/**
 * Tracks active VC session start times and stream start times in memory.
 * On startup, both are restored/seeded so duration tracking works
 * accurately even after a bot restart.
 *
 * Key format: `${guildId}_${userId}`
 */

const { startSession, getOpenSession } = require('./vcSessions');

const joinTimes   = new Map(); // guildId_userId → join timestamp (ms)
const streamTimes = new Map(); // guildId_userId → stream start timestamp (ms)

/**
 * Seed join times and stream times for all members currently in voice channels.
 * Called from ready.js after auto-rejoin.
 *
 * Join times:
 *   - If an open DB session exists → restore original joined_at (real time)
 *   - If no open session → start fresh from now, write new session row
 *
 * Stream times:
 *   - If member is currently streaming → seed from now
 *   - Can't know the real stream start time after a restart without storing it
 *     separately, so we use now as an approximation — at least it won't show Unknown
 */
function initGuild(guild) {
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased()) continue;

    for (const member of channel.members.values()) {
      if (member.user.bot) continue;

      const key = `${guild.id}_${member.user.id}`;

      // ── Seed join time ────────────────────────────────────────────────────
      if (!joinTimes.has(key)) {
        const openSession = getOpenSession(member.user.id, guild.id);

        if (openSession) {
          // Restore original join time from DB — accurate across restarts
          joinTimes.set(key, openSession.joined_at);
        } else {
          // No DB record — member joined while bot was offline
          joinTimes.set(key, Date.now());
          startSession(member.user.id, guild.id, channel.id, channel.name, {
            username: member.user.username,
            avatarUrl: member.user.displayAvatarURL({ size: 128 }),
          });
        }
      }

      // ── Seed stream time ──────────────────────────────────────────────────
      // If the member is currently streaming and we don't have a start time,
      // seed it to now. Not perfectly accurate but prevents Unknown on stop.
      if (member.voice?.streaming && !streamTimes.has(key)) {
        streamTimes.set(key, Date.now());
      }
    }
  }
}

module.exports = { joinTimes, streamTimes, initGuild };
