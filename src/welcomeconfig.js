/*
 * Welcome/leave config, bridging the dashboard (Supabase guild_configs) and
 * the bot's existing local JSON store (src/guildConfig.js).
 *
 * Previously the bot ONLY ever read welcomeChannelId/leaveChannelId from its
 * local data/guild-config.json — the dashboard writes to Supabase's
 * guild_configs table, which the bot never looked at. Setting the welcome
 * channel from the dashboard did nothing to the real bot.
 *
 * Supabase is now the source of truth when it's reachable — both /welcome
 * setup (Discord) and the dashboard write through to it, and reads prefer
 * it. Local JSON remains as a fallback (used automatically if Supabase
 * isn't configured or a request fails), so the bot keeps working standalone
 * if Supabase has a hiccup.
 *
 * The require for bot-modules/supabase-client is intentionally done INSIDE
 * each function, not at the top of this file — that module throws
 * synchronously if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are missing, and
 * this file is required unconditionally by events/guildMemberAdd.js etc. A
 * top-level require here would reintroduce the exact "one missing env var
 * crashes the whole bot" bug that was already fixed in index.js.
 */

const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { log } = require('./logger');

function getSupabaseOrNull() {
  try {
    return require('../bot-modules/supabase-client').supabase;
  } catch {
    return null; // not configured — caller falls back to local JSON
  }
}

const DEFAULT_CARD_CONFIG = {
  nameMode: 'nickname',       // 'nickname' | 'username'
  accentColor: null,          // null = use the bot's built-in default per type
  avatarPosition: 'center',   // 'left' | 'center' | 'right'
  textAlign: 'center',        // 'left' | 'center' | 'right'
};

function normalizeCardConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    nameMode: c.nameMode === 'username' ? 'username' : DEFAULT_CARD_CONFIG.nameMode,
    accentColor: typeof c.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.accentColor)
      ? c.accentColor
      : DEFAULT_CARD_CONFIG.accentColor,
    avatarPosition: ['left', 'center', 'right'].includes(c.avatarPosition)
      ? c.avatarPosition
      : DEFAULT_CARD_CONFIG.avatarPosition,
    textAlign: ['left', 'center', 'right'].includes(c.textAlign)
      ? c.textAlign
      : DEFAULT_CARD_CONFIG.textAlign,
  };
}

/**
 * Reads welcome config for a guild. Tries Supabase first, falls back to the
 * local JSON cache (and updates that cache on a successful Supabase read).
 */
async function getWelcomeConfig(guildId) {
  const supabase = getSupabaseOrNull();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('guild_configs')
        .select('welcome_channel_id, leave_channel_id, welcome_card_config')
        .eq('guild_id', guildId)
        .maybeSingle();
      if (!error && data) {
        const result = {
          welcomeChannelId: data.welcome_channel_id || null,
          leaveChannelId: data.leave_channel_id || null,
          cardConfig: normalizeCardConfig(data.welcome_card_config),
        };
        // Keep the local cache warm as a fallback for when Supabase is down.
        setGuildConfig(guildId, {
          welcomeChannelId: result.welcomeChannelId,
          leaveChannelId: result.leaveChannelId,
          welcomeCardConfig: result.cardConfig,
        });
        return result;
      }
    } catch (err) {
      log('WARN', 'Supabase welcome-config read failed, falling back to local cache', { error: err.message });
    }
  }

  const local = getGuildConfig(guildId);
  return {
    welcomeChannelId: local.welcomeChannelId || null,
    leaveChannelId: local.leaveChannelId || null,
    cardConfig: normalizeCardConfig(local.welcomeCardConfig),
  };
}

/**
 * Writes welcome config for a guild. Always updates the local cache;
 * additionally pushes to Supabase when it's configured and reachable, so
 * /welcome setup (Discord-side) is visible on the dashboard too.
 */
async function setWelcomeConfig(guildId, updates) {
  const localUpdates = {};
  if ('welcomeChannelId' in updates) localUpdates.welcomeChannelId = updates.welcomeChannelId;
  if ('leaveChannelId' in updates) localUpdates.leaveChannelId = updates.leaveChannelId;
  if ('cardConfig' in updates) localUpdates.welcomeCardConfig = normalizeCardConfig(updates.cardConfig);
  setGuildConfig(guildId, localUpdates);

  const supabase = getSupabaseOrNull();
  if (!supabase) return;

  const remoteUpdates = { guild_id: guildId, updated_at: new Date().toISOString() };
  if ('welcomeChannelId' in updates) remoteUpdates.welcome_channel_id = updates.welcomeChannelId;
  if ('leaveChannelId' in updates) remoteUpdates.leave_channel_id = updates.leaveChannelId;
  if ('cardConfig' in updates) remoteUpdates.welcome_card_config = normalizeCardConfig(updates.cardConfig);

  try {
    // upsert, not update — a guild_configs row might not exist yet if no
    // admin has ever opened the dashboard for this guild. The bot shouldn't
    // depend on that having happened first.
    await supabase.from('guild_configs').upsert(remoteUpdates, { onConflict: 'guild_id' });
  } catch (err) {
    log('WARN', 'Supabase welcome-config write failed (local cache still updated)', { error: err.message });
  }
}

module.exports = { getWelcomeConfig, setWelcomeConfig, normalizeCardConfig, DEFAULT_CARD_CONFIG };
