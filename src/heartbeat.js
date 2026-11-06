const { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { log }                 = require('./logger');
const store                   = require('./connectionStore');
const { setStats }            = require('./guildConfig');
const { attachSilencePlayer } = require('./audioPlayer');

const HEARTBEAT_INTERVAL = 2 * 60 * 1000;  // Check every 2 minutes
const LOG_EVERY_N_CHECKS = 30;              // Log healthy status every 30 checks (~1 hour)

const HEALTHY = [
  VoiceConnectionStatus.Ready,
  VoiceConnectionStatus.Signalling,
  VoiceConnectionStatus.Connecting,
];

let checkCount = 0;

function startHeartbeat(client) {
  log('HEART', 'Heartbeat started — checking every 2 minutes, logging every ~1 hour');

  setInterval(async () => {
    checkCount++;
    const entries    = store.getAllEntries();
    const shouldLog  = checkCount % LOG_EVERY_N_CHECKS === 0;

    if (entries.length === 0) return;

    let allHealthy = true;

    for (const [guildId, meta] of entries) {
      const conn = getVoiceConnection(guildId);

      if (conn && HEALTHY.includes(conn.state.status)) {
        // Only log healthy connections once per hour — not every 2 minutes
        if (shouldLog) {
          log('HEART', 'Hourly check — connection healthy', {
            guild:      meta.guildName,
            channel:    meta.channelName,
            uptime:     store.formatUptime(meta.joinedAt),
            reconnects: meta.reconnectCount,
          });
        }
        continue;
      }

      // Ghost detected — always log immediately regardless of interval
      allHealthy = false;
      log('GHOST', 'Ghost detected — attempting auto-rejoin', {
        guild: meta.guildName, channel: meta.channelName,
      });

      if (conn) { try { conn.destroy(); } catch (_) {} }

      try {
        const guild   = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(meta.channelId);

        if (!channel?.isVoiceBased()) {
          log('GHOST', 'Target channel gone — clearing', { guild: meta.guildName });
          store.clearConnection(guildId);
          continue;
        }

        const newConn = joinVoiceChannel({
          channelId:      channel.id,
          guildId:        guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf:       true,
          selfMute:       false,
        });

        attachDisconnectHandler(newConn, guild.name, channel.name);
        attachSilencePlayer(newConn, guild.id);
        store.incrementReconnect(guildId);

        const entry = store.getEntry(guildId);
        if (entry) setStats(guildId, { joinedAt: entry.joinedAt, reconnectCount: entry.reconnectCount });

        log('VOICE', 'Auto-rejoined after ghost', {
          guild: guild.name, channel: channel.name, reconnects: entry?.reconnectCount,
        });

        const { updatePanel } = require('./statusUpdater');
        await updatePanel(client);

      } catch (err) {
        log('ERROR', 'Auto-rejoin failed', { guild: meta.guildName, err });
        store.clearConnection(guildId);
      }
    }

    // Single summary log every hour if everything is fine
    if (shouldLog && allHealthy && entries.length > 0) {
      log('HEART', `Hourly summary — all ${entries.length} connection(s) healthy`);
    }

  }, HEARTBEAT_INTERVAL);
}

// joinVoiceChannel() hands back the SAME connection object when the bot is already in
// that guild, so without this guard every re-join stacked another set of handlers on it.
const handledConnections = new WeakSet();

function attachDisconnectHandler(connection, guildName, channelName) {
  if (handledConnections.has(connection)) return;
  handledConnections.add(connection);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log('VOICE', 'Disconnected — attempting quick reconnect', { guild: guildName, channel: channelName });
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 15_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 15_000),
      ]);
      log('VOICE', 'Quick reconnect succeeded', { guild: guildName, channel: channelName });
    } catch {
      log('WARN', 'Quick reconnect timed out — heartbeat will handle it', { guild: guildName, channel: channelName });
      try { connection.destroy(); } catch (_) {}
    }
  });

  connection.on('error', (err) => {
    log('ERROR', 'Voice connection error', { guild: guildName, channel: channelName, err });
  });
}

module.exports = { startHeartbeat, attachDisconnectHandler };
