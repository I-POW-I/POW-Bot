/**
 * Streamer polling engine.
 *
 * Intervals: Kick 60s · Twitch 60s · YouTube 5min
 *
 * API errors are throttled — same failure only logs once per 30 minutes
 * per streamer to keep the console clean.
 *
 * When a stream ends the Discord message is deleted (not edited).
 * While live the embed is refreshed every 5 minutes to update viewer count.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log }            = require('./logger');
const { selectAll, run } = require('./database');

const kick    = require('./platforms/kick');
const twitch  = require('./platforms/twitch');
const youtube = require('./platforms/youtube');

const INTERVALS      = { kick: 60_000, twitch: 60_000, youtube: 5 * 60_000 };
const UPDATE_COOLDOWN = 5 * 60_000;   // Min time between live embed refreshes
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

// ── Check a single subscription ────────────────────────────────────────────────

async function checkSubscription(client, sub) {
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
      log('WARN', `Failed to post live notification for ${sub.display_name || sub.username}`, { error: err.message });
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

async function pollPlatform(client, platform) {
  const subs = selectAll('SELECT * FROM streamer_subscriptions WHERE platform = ?', [platform]);
  for (const sub of subs) {
    await checkSubscription(client, sub);
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

async function startStreamerPoller(client) {
  const hasTwitch  = !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
  const hasYoutube = !!process.env.YOUTUBE_API_KEY;

  log('INFO', 'Streamer poller online', {
    kick:    'enabled',
    twitch:  hasTwitch  ? 'enabled' : 'disabled — set TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET',
    youtube: hasYoutube ? 'enabled' : 'disabled — set YOUTUBE_API_KEY',
  });

  if (hasTwitch) await twitch.validateCredentials();

  setTimeout(() => { pollPlatform(client, 'kick'); setInterval(() => pollPlatform(client, 'kick'), INTERVALS.kick); }, 5000);
  if (hasTwitch)  setTimeout(() => { pollPlatform(client, 'twitch'); setInterval(() => pollPlatform(client, 'twitch'), INTERVALS.twitch); }, 10000);
  if (hasYoutube) setTimeout(() => { pollPlatform(client, 'youtube'); setInterval(() => pollPlatform(client, 'youtube'), INTERVALS.youtube); }, 15000);
}

module.exports = { startStreamerPoller };
