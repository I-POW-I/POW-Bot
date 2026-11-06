/**
 * Streamer polling engine.
 *
 * Intervals: Kick 60s · Twitch 60s · YouTube 5min
 *
 * Twitch also has instant push events (EventSub — see platforms/twitchEventSub.js).
 * While those are healthy, Twitch streamers they cover are only re-checked every
 * 5 minutes as a safety net; everything else is polled as above.
 *
 * API errors are throttled — same failure only logs once per 30 minutes
 * per streamer to keep the console clean.
 *
 * When a stream ends the Discord message is deleted (not edited).
 * While live the embed is refreshed every 5 minutes to update viewer count.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log }            = require('./logger');
const { selectAll, selectOne, run } = require('./database');

const kick    = require('./platforms/kick');
const twitch  = require('./platforms/twitch');
const youtube = require('./platforms/youtube');
const twitchEventSub = require('./platforms/twitchEventSub');

const INTERVALS      = { kick: 60_000, twitch: 60_000, youtube: 5 * 60_000 };
const UPDATE_COOLDOWN = 5 * 60_000;   // Min time between live embed refreshes
const RECONCILE_MS    = 5 * 60_000;   // Safety-net poll interval for streamers EventSub covers
const ERROR_THROTTLE  = 30 * 60_000;  // Only log same error once per 30 min

const COLOURS = { kick: 0x53FC18, twitch: 0x9146FF, youtube: 0xFF0000 };
const NAMES   = { kick: 'Kick',   twitch: 'Twitch', youtube: 'YouTube' };
const ICONS   = {
  kick:    'https://kick.com/favicon.ico',
  twitch:  'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c1.png',
  youtube: 'https://www.youtube.com/favicon.ico',
};

// Track last error log time per streamer to avoid spam
const errorLastLogged = new Map();

function throttleLog(key, message, extra = {}) {
  const last = errorLastLogged.get(key) || 0;
  if (Date.now() - last < ERROR_THROTTLE) return;
  errorLastLogged.set(key, Date.now());
  log('WARN', message, extra);
}

// ── Embed builder ──────────────────────────────────────────────────────────────

function buildLiveEmbed(platform, sub, status) {
  const name  = sub.display_name || status.displayName || sub.username;
  const embed = new EmbedBuilder()
    .setColor(COLOURS[platform])
    .setAuthor({ name: NAMES[platform], iconURL: ICONS[platform] })
    .setTitle(`🔴 ${name} is now live!`)
    .setURL(status.url)
    .setDescription(status.title || 'No stream title')
    .setTimestamp()
    .setFooter({ text: `${NAMES[platform]} • Live` });

  if (status.category) {
    embed.addFields({ name: '🎮 Playing', value: status.category, inline: true });
  }

  if (status.viewers !== null && status.viewers >= 0) {
    embed.addFields({ name: '👥 Viewers', value: status.viewers.toLocaleString(), inline: true });
  }

  if (status.thumbnail) embed.setImage(status.thumbnail);

  return embed;
}

function buildWatchButton(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Watch Stream')
      .setURL(url)
      .setEmoji('🔴')
      .setStyle(ButtonStyle.Link)
  );
}

// ── Per-subscription lock ──────────────────────────────────────────────────────
// A poll and an EventSub push can land for the same streamer at the same moment.
// Running them one after another (each re-reading the row first) guarantees only
// one of them posts the "is live" message.

const locks = new Map();

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.catch(() => {}).finally(() => { if (locks.get(id) === next) locks.delete(id); });
  return next;
}

// ── Check a single subscription ────────────────────────────────────────────────

function checkSubscription(client, sub) {
  return withLock(sub.id, async () => {
    const fresh = selectOne('SELECT * FROM streamer_subscriptions WHERE id = ?', [sub.id]);
    if (!fresh) return;                        // removed while we were waiting
    return checkSubscriptionLocked(client, fresh);
  });
}

async function checkSubscriptionLocked(client, sub) {
  const modules  = { kick, twitch, youtube };
  const mod      = modules[sub.platform];
  if (!mod) return;

  const errKey = `${sub.platform}:${sub.username}`;
  const status  = await mod.getStreamStatus(sub.username);

  // API returned an error object
  if (!status || status.error) {
    const errCode = status?.error;
    if (errCode === 403) {
      throttleLog(errKey, `${NAMES[sub.platform]}: access blocked for ${sub.display_name || sub.username} (403) — Kick/Twitch may be blocking this server's IP or credentials are wrong`);
    } else if (typeof errCode === 'string') {
      throttleLog(errKey, `${NAMES[sub.platform]} check failed for ${sub.display_name || sub.username}`, { error: errCode });
    } else {
      throttleLog(errKey, `${NAMES[sub.platform]} check failed for ${sub.display_name || sub.username}`);
    }
    return;
  }

  // Clear error throttle on successful response
  errorLastLogged.delete(errKey);

  const wasLive   = sub.is_live === 1;
  const isNowLive = status.isLive;

  // ── Just went live ──────────────────────────────────────────────────────────
  if (!wasLive && isNowLive) {
    log('INFO', `${NAMES[sub.platform]}: ${sub.display_name || sub.username} went live`);

    try {
      const guild   = await client.guilds.fetch(sub.guild_id);
      const channel = await guild.channels.fetch(sub.discord_channel_id);
      if (!channel?.isTextBased()) return;

      const content = sub.role_id ? `<@&${sub.role_id}>` : undefined;
      const message = await channel.send({
        content,
        embeds:     [buildLiveEmbed(sub.platform, sub, status)],
        components: [buildWatchButton(status.url)],
      });

      run(
        `UPDATE streamer_subscriptions
         SET is_live = 1, last_message_id = ?, last_went_live = ?,
             last_stream_title = ?, last_updated_at = ?
         WHERE id = ?`,
        [message.id, Date.now(), status.title, Date.now(), sub.id]
      );
    } catch (err) {
      log('WARN', `Failed to post live notification for ${sub.display_name || sub.username}`, { err });
    }
  }

  // ── Still live — refresh embed viewer count every 5 min ────────────────────
  else if (wasLive && isNowLive) {
    const lastUpdated = sub.last_updated_at || 0;
    if (Date.now() - lastUpdated < UPDATE_COOLDOWN) return;
    if (!sub.last_message_id) return;

    try {
      const guild   = await client.guilds.fetch(sub.guild_id);
      const channel = await guild.channels.fetch(sub.discord_channel_id);
      const message = await channel?.messages.fetch(sub.last_message_id).catch(() => null);
      if (!message) return;

      await message.edit({
        embeds:     [buildLiveEmbed(sub.platform, sub, status)],
        components: [buildWatchButton(status.url)],
      });

      run(
        'UPDATE streamer_subscriptions SET last_stream_title = ?, last_updated_at = ? WHERE id = ?',
        [status.title, Date.now(), sub.id]
      );
    } catch { /* silent — message may have been manually deleted */ }
  }

  // ── Just went offline — delete the message ─────────────────────────────────
  else if (wasLive && !isNowLive) {
    log('INFO', `${NAMES[sub.platform]}: ${sub.display_name || sub.username} went offline`);

    if (sub.last_message_id) {
      try {
        const guild   = await client.guilds.fetch(sub.guild_id);
        const channel = await guild.channels.fetch(sub.discord_channel_id);
        const message = await channel?.messages.fetch(sub.last_message_id).catch(() => null);
        if (message) await message.delete();
      } catch { /* message already gone */ }
    }

    run('UPDATE streamer_subscriptions SET is_live = 0, last_message_id = NULL, last_updated_at = NULL WHERE id = ?', [sub.id]);
  }
}

// ── Poll platform ──────────────────────────────────────────────────────────────

const lastReconciled = new Map();   // subscription id → last time we checked it

async function pollPlatform(client, platform) {
  if (!require('./globalConfig').featureEnabled('streamerAlerts')) return;   // global switch (/owner features)
  const subs = selectAll('SELECT * FROM streamer_subscriptions WHERE platform = ?', [platform]);

  for (const sub of subs) {
    // EventSub is delivering for this streamer → only do the occasional safety-net check
    if (platform === 'twitch' && twitchEventSub.covers(sub.username) &&
        Date.now() - (lastReconciled.get(sub.id) || 0) < RECONCILE_MS) continue;

    await checkSubscription(client, sub);
    lastReconciled.set(sub.id, Date.now());
    await new Promise(r => setTimeout(r, 500));
  }

  const live = new Set(subs.map(s => s.id));                // forget removed subscriptions
  for (const id of lastReconciled.keys()) if (!live.has(id)) lastReconciled.delete(id);
}

// ── EventSub push handler ──────────────────────────────────────────────────────
// Twitch's "streams" API can lag a few seconds behind the push event, so if it
// doesn't show the expected state yet we look again a little later.

async function handleEventSubSignal(client, login, kind, opts = {}) {
  if (!require('./globalConfig').featureEnabled('streamerAlerts')) return;
  const delays = opts.delays || (kind === 'online' ? [0, 4_000, 12_000, 30_000] : [0, 8_000]);
  const find   = () => selectAll(
    "SELECT * FROM streamer_subscriptions WHERE platform = 'twitch' AND LOWER(username) = ?", [login.toLowerCase()]
  );

  for (const delay of delays) {
    if (delay) await new Promise(r => setTimeout(r, delay));

    const subs = find();
    if (subs.length === 0) return;
    for (const sub of subs) {
      await checkSubscription(client, sub);
      lastReconciled.set(sub.id, Date.now());
    }

    const settled = find().every(s => kind === 'online' ? s.is_live === 1 : s.is_live !== 1);
    if (settled) return;
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

async function startStreamerPoller(client) {
  const hasTwitch  = twitch.hasCredentials();
  const hasYoutube = !!process.env.YOUTUBE_API_KEY;
  const hasKick    = kick.hasCredentials();

  log('INFO', 'Streamer poller online', {
    kick:    hasKick ? 'enabled (official API)' : 'legacy unofficial API — set KICK_CLIENT_ID + KICK_CLIENT_SECRET',
    twitch:  hasTwitch  ? 'enabled' : 'disabled — set TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET',
    youtube: hasYoutube ? 'enabled' : 'disabled — set YOUTUBE_API_KEY',
  });

  await kick.validateCredentials();
  if (hasTwitch) {
    await twitch.validateCredentials();
    // Instant push alerts; polling keeps running as the safety net either way.
    twitchEventSub.start({
      onSignal: (login, kind) => handleEventSubSignal(client, login, kind),
    }).catch(err => log('WARN', `Twitch EventSub failed to start: ${err.message}`));
  }

  setTimeout(() => { pollPlatform(client, 'kick'); setInterval(() => pollPlatform(client, 'kick'), INTERVALS.kick); }, 5000);
  if (hasTwitch)  setTimeout(() => { pollPlatform(client, 'twitch'); setInterval(() => pollPlatform(client, 'twitch'), INTERVALS.twitch); }, 10000);
  if (hasYoutube) setTimeout(() => { pollPlatform(client, 'youtube'); setInterval(() => pollPlatform(client, 'youtube'), INTERVALS.youtube); }, 15000);
}

module.exports = { startStreamerPoller, handleEventSubSignal, pollPlatform, checkSubscription };
