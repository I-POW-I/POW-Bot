/**
 * Voice state logging.
 * Requires View Audit Log permission for mod detection.
 */

const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }                      = require('../src/logger');
const { getLogChannel }            = require('../src/guildConfig');
const { joinTimes, streamTimes }   = require('../src/memberTracker');
const { startSession, endSession } = require('../src/database');

const C = {
  join:           0x57F287,
  leave:          0xED4245,
  forceLeave:     0xFF7043,
  move:           0x5865F2,
  modMove:        0xFF7043,
  serverMute:     0xFF7043,
  serverUnmute:   0x57F287,
  serverDeafen:   0xFF7043,
  serverUndeafen: 0x57F287,
  streamStart:    0x9C59D1,
  streamStop:     0x747F8D,
};

function base(member, colour, title) {
  return new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setTitle(title)
    .setTimestamp();
}

function formatDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function getMuteDeafMod(guild, userId, windowMs = 4000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
    const entry = logs.entries.find(e =>
      e.target?.id === userId && (Date.now() - e.createdTimestamp) < windowMs
    );
    return entry?.executor ? `${entry.executor} — ${entry.executor.tag}` : null;
  } catch { return null; }
}

async function getMoveMod(guild, destChannelId, windowMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberMove, limit: 5 });
    const entry = logs.entries.find(e =>
      (Date.now() - e.createdTimestamp) < windowMs &&
      e.extra?.channel?.id === destChannelId
    );
    return entry?.executor ? `${entry.executor} — ${entry.executor.tag}` : null;
  } catch { return null; }
}

async function getDisconnectMod(guild, windowMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberDisconnect, limit: 3 });
    const entry = logs.entries.find(e => (Date.now() - e.createdTimestamp) < windowMs);
    return entry?.executor ? `${entry.executor} — ${entry.executor.tag}` : null;
  } catch { return null; }
}

async function sendLog(guild, embed) {
  const channelId = getLogChannel(guild.id, 'voice');
  if (!channelId) return;
  try {
    const ch = await guild.channels.fetch(channelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (err) {
    log('WARN', 'Failed to send voice log', { error: err.message });
  }
}

module.exports = {
  name: Events.VoiceStateUpdate,
  once: false,

  async execute(oldState, newState) {
    // ── Anti-Drag Verification Block ──────────────────────────────────────────
    if (newState.id === newState.client.user.id) {
      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      // Only act if the bot moved from an active channel to an unapproved one
      if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        const store = require('../src/connectionStore'); // Corrected path for your root events folder!
        const entry = store.getEntry(newState.guild.id);

        if (entry && newChannel.id !== entry.channelId) {
          log('WARN', `Anti-Drag caught move to ${newChannel.name}. Snapping back to ${entry.channelName}`);
          
          try {
            const { joinVoiceChannel } = require('@discordjs/voice');
            joinVoiceChannel({
              channelId: entry.channelId,
              guildId: newState.guild.id,
              adapterCreator: newState.guild.voiceAdapterCreator,
              selfMute: false,
              selfDeaf: true
            });
          } catch (error) {
            log('ERROR', 'Anti-Drag pull-back failed', { message: error.message });
          }
          return; // Stop execution here so the bot doesn't write normal user tracking logs for itself
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const guild      = newState.guild;
    const oldChannel = oldState.channel;
    const newChannel = newState.channel;
    const key        = `${guild.id}_${member.user.id}`;

    // ── Join ──────────────────────────────────────────────────────────────────
    if (!oldChannel && newChannel) {
      joinTimes.set(key, Date.now());
      startSession(member.user.id, guild.id, newChannel.id, newChannel.name);

      await sendLog(guild, base(member, C.join, 'Member Joined Voice')
        .addFields(
          { name: 'Channel',     value: `<#${newChannel.id}>`, inline: true },
          { name: 'Members Now', value: `${newChannel.members.size}`,        inline: true },
          { name: '\u200b',      value: '\u200b',                            inline: true },
        ));
      return;
    }

    // ── Leave ─────────────────────────────────────────────────────────────────
    if (oldChannel && !newChannel) {
      const duration = joinTimes.has(key)
        ? formatDuration(Date.now() - joinTimes.get(key))
        : null;

      joinTimes.delete(key);
      streamTimes.delete(key);
      endSession(member.user.id, guild.id);

      const disconnectedBy = await getDisconnectMod(guild);

      if (disconnectedBy) {
        await sendLog(guild, base(member, C.forceLeave, 'Member Disconnected by Moderator')
          .addFields(
            { name: 'Channel',         value: `<#${oldChannel.id}>`, inline: true },
            { name: 'Was In',          value: duration || 'Unknown',  inline: true },
            { name: '\u200b',          value: '\u200b',               inline: true },
            { name: 'Disconnected By', value: disconnectedBy,         inline: false },
          ));
      } else {
        await sendLog(guild, base(member, C.leave, 'Member Left Voice')
          .addFields(
            { name: 'Channel', value: `<#${oldChannel.id}>`, inline: true },
            { name: 'Was In',  value: duration || 'Unknown',  inline: true },
            { name: '\u200b',  value: '\u200b',               inline: true },
          ));
      }
      return;
    }

    // ── Move between channels ─────────────────────────────────────────────────
    if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
      endSession(member.user.id, guild.id);
      startSession(member.user.id, guild.id, newChannel.id, newChannel.name);
      // Do NOT reset joinTimes — keep original so duration on leave shows total time

      const movedBy = await getMoveMod(guild, newChannel.id);
      const embed   = base(member,
        movedBy ? C.modMove : C.move,
        movedBy ? 'Member Moved by Moderator' : 'Member Changed Channel')
        .addFields(
          { name: 'From',    value: `<#${oldChannel.id}>`, inline: true },
          { name: 'To',      value: `<#${newChannel.id}>`, inline: true },
          { name: '\u200b',  value: '\u200b',              inline: true },
        );

      if (movedBy) embed.addFields({ name: 'Moved By', value: movedBy, inline: false });
      await sendLog(guild, embed);
      return;
    }

    // ── Server mute/unmute ────────────────────────────────────────────────────
    if (oldState.serverMute !== newState.serverMute) {
      const mod = await getMuteDeafMod(guild, member.id);
      await sendLog(guild, base(member,
        newState.serverMute ? C.serverMute : C.serverUnmute,
        newState.serverMute ? 'Member Server Muted' : 'Member Server Unmuted')
        .addFields(
          { name: 'Channel',   value: newChannel ? `<#${newChannel.id}>` : '—', inline: true },
          { name: 'Action By', value: mod || 'Unknown',                          inline: true },
          { name: '\u200b',    value: '\u200b',                                  inline: true },
        ));
      return;
    }

    // ── Server deafen/undeafen ────────────────────────────────────────────────
    if (oldState.serverDeaf !== newState.serverDeaf) {
      const mod = await getMuteDeafMod(guild, member.id);
      await sendLog(guild, base(member,
        newState.serverDeaf ? C.serverDeafen : C.serverUndeafen,
        newState.serverDeaf ? 'Member Server Deafened' : 'Member Server Undeafened')
        .addFields(
          { name: 'Channel',   value: newChannel ? `<#${newChannel.id}>` : '—', inline: true },
          { name: 'Action By', value: mod || 'Unknown',                          inline: true },
          { name: '\u200b',    value: '\u200b',                                  inline: true },
        ));
      return;
    }

    // ── Stream start/stop ─────────────────────────────────────────────────────
    if (oldState.streaming !== newState.streaming) {
      if (newState.streaming) {
        streamTimes.set(key, Date.now());
        await sendLog(guild, base(member, C.streamStart, 'Member Started Streaming')
          .addFields(
            { name: 'Channel', value: newChannel ? `<#${newChannel.id}>` : '—', inline: true },
            { name: '\u200b',  value: '\u200b',                                  inline: true },
            { name: '\u200b',  value: '\u200b',                                  inline: true },
          ));
      } else {
        const duration = streamTimes.has(key)
          ? formatDuration(Date.now() - streamTimes.get(key))
          : null;
        streamTimes.delete(key);
        await sendLog(guild, base(member, C.streamStop, 'Member Stopped Streaming')
          .addFields(
            { name: 'Channel',      value: newChannel ? `<#${newChannel.id}>` : '—', inline: true },
            { name: 'Streamed For', value: duration || 'Unknown',                     inline: true },
            { name: '\u200b',       value: '\u200b',                                  inline: true },
          ));
      }
      return;
    }
  },
};
