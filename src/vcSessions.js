/*
 * VC session tracking — bridges the bot's local SQLite tracking
 * (src/database.js) with Supabase's vc_sessions table, which is what the
 * dashboard's "VC Sessions (30d)" stat and "VC Leaderboard" page actually
 * read from. Previously these were two entirely disconnected stores — the
 * bot tracked real VC time locally, the dashboard always showed 0.
 *
 * Design: only the WRITE path (startSession/endSession) needs to reach
 * Supabase — that's the only thing the dashboard can't get any other way.
 * Stat READS (getUserStats/getServerTotals) stay synchronous and
 * local-only, exactly as before: the bot's own embeds already have the
 * fastest, most reliable source sitting right there in local SQLite, and
 * making these async to also check Supabase would cascade through every
 * caller (buildMemberEmbed, buildStatsEmbed, and everything that calls
 * those) for a benefit only the dashboard actually needs.
 *
 * startSession/endSession keep the EXACT same synchronous calling
 * convention as database.js's originals — callers don't need to change
 * how they invoke these, only which file they require them from. The
 * Supabase mirror runs in the background via .then()/an internal async
 * IIFE and can never block or throw back into the caller.
 *
 * The require for bot-modules/supabase-client is intentionally done
 * INSIDE each function, not at the top of this file — that module throws
 * synchronously if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are missing, and
 * this file is required unconditionally by events/voiceStateUpdate.js etc.
 */

const localDb = require('./database');
const { log } = require('./logger');

function getSupabaseOrNull() {
  try {
    return require('../bot-modules/supabase-client').supabase;
  } catch {
    return null;
  }
}

/**
 * Starts tracking a VC session. Always tracks locally (synchronous, as
 * before); best-effort mirrors to Supabase in the background. `memberInfo`
 * (optional) can carry { username, avatarUrl } for nicer dashboard display.
 */
function startSession(userId, guildId, channelId, channelName, memberInfo = {}) {
  localDb.startSession(userId, guildId, channelId, channelName);

  const supabase = getSupabaseOrNull();
  if (!supabase) return;
  supabase.from('vc_sessions').insert({
    user_discord_id: userId,
    guild_id: guildId,
    channel_id: channelId,
    channel_name: channelName,
    username: memberInfo.username || null,
    avatar_url: memberInfo.avatarUrl || null,
    joined_at: new Date().toISOString(),
  }).then(({ error }) => {
    if (error) log('WARN', 'Supabase vc_sessions insert failed (local tracking still active)', { error: error.message });
  }).catch((err) => {
    log('WARN', 'Supabase vc_sessions insert failed (local tracking still active)', { error: err.message });
  });
}

/**
 * Ends the most recent open session for this user/guild. Always ends the
 * local session (synchronous, as before); best-effort ends the matching
 * Supabase one in the background.
 */
function endSession(userId, guildId) {
  localDb.endSession(userId, guildId);

  const supabase = getSupabaseOrNull();
  if (!supabase) return;
  (async () => {
    try {
      const { data: openRows, error: selectError } = await supabase
        .from('vc_sessions')
        .select('id, joined_at')
        .eq('user_discord_id', userId)
        .eq('guild_id', guildId)
        .is('left_at', null)
        .order('joined_at', { ascending: false })
        .limit(1);
      if (selectError || !openRows?.length) return;

      const open = openRows[0];
      const now = new Date();
      const durationMs = now.getTime() - new Date(open.joined_at).getTime();
      await supabase
        .from('vc_sessions')
        .update({ left_at: now.toISOString(), duration_ms: Math.max(0, durationMs) })
        .eq('id', open.id);
    } catch (err) {
      log('WARN', 'Supabase vc_sessions close failed (local tracking still recorded it)', { error: err.message });
    }
  })();
}

// Everything else is unchanged local-only behaviour — same functions,
// same signatures, just re-exported from here so callers only need to
// change which file they require.
module.exports = {
  startSession, endSession,
  getOpenSession: localDb.getOpenSession,
  getUserStats: localDb.getUserStats,
  getServerTotals: localDb.getServerTotals,
  formatMs: localDb.formatMs,
};
