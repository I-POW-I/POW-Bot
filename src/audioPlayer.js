/**
 * Silent audio stream — keeps the bot's voice connection alive 24/7.
 *
 * Discord can silently drop connections that aren't sending any audio.
 * This plays a continuous stream of silence (zero-byte PCM frames) so
 * Discord always sees the bot as an active audio participant.
 *
 * Requires: opusscript (Opus encoding) + libsodium-wrappers (packet encryption)
 */

const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { Readable } = require('stream');

// 20ms of 48kHz stereo 16-bit PCM silence = 3840 bytes per frame
const SILENCE_FRAME = Buffer.alloc(3840, 0);

class SilenceStream extends Readable {
  _read() {
    this.push(SILENCE_FRAME);
  }
}

// One player per guild — tracked here so we can stop cleanly on leave
// guildId → { player, subscription }
const players = new Map();

/**
 * Attach a silent audio player to a voice connection.
 * Call this every time the bot joins a channel.
 * @param {import('@discordjs/voice').VoiceConnection} connection
 * @param {string} guildId
 */
function attachSilencePlayer(connection, guildId) {
  // Clean up any existing player for this guild
  stopSilencePlayer(guildId);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  const play = () => {
    const resource = createAudioResource(new SilenceStream(), {
      inputType: StreamType.Raw,
    });
    player.play(resource);
  };

  // Loop continuously — when one resource ends, start another
  player.on(AudioPlayerStatus.Idle, play);
  // An unhandled 'error' event on an EventEmitter would throw — restart instead
  player.on('error', () => { try { play(); } catch (_) {} });
  play();

  const subscription = connection.subscribe(player);
  players.set(guildId, { player, subscription });

  // If this connection is destroyed (timeout, kicked, channel deleted…) make sure
  // its player doesn't keep spinning in the background with nobody listening.
  if (typeof connection.once === 'function') {
    connection.once(VoiceConnectionStatus.Destroyed, () => {
      const current = players.get(guildId);
      if (current && current.player === player) stopSilencePlayer(guildId);
    });
  }
}

/**
 * Stop and remove the audio player for a guild.
 * Call this on leave / forceleave.
 * @param {string} guildId
 */
function stopSilencePlayer(guildId) {
  const entry = players.get(guildId);
  if (!entry) return;
  players.delete(guildId);

  const { player, subscription } = entry;

  // IMPORTANT: remove the Idle→play() loop *before* stopping. player.stop(true)
  // moves the player to Idle, and the loop listener would immediately start a
  // brand-new silence resource, so the "stopped" player kept running forever
  // (one leaked player + opus encoder per rejoin).
  player.removeAllListeners();
  player.on('error', () => {}); // swallow any late errors from the dying resource

  try { subscription?.unsubscribe(); } catch (_) {}
  try { player.stop(true); } catch (_) {}
}

module.exports = { attachSilencePlayer, stopSilencePlayer };
