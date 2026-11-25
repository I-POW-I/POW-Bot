/**
 * Join to create: members who join the "hub" voice channel get a voice channel of their own, and are moved into it.
 * The room is deleted as soon as it is empty.
 *
 * Saved per server as  tempVoice: { hubId, name, limit, rooms: { <channelId>: <ownerId> } }
 * The list of rooms is kept so rooms are still cleaned up after a restart.
 */

const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { log } = require('./logger');

const MAX_ROOMS = 25, COOLDOWN_MS = 8000;
const NAMES = [["{user}'s room", "{user}'s room"], ["{user}'s lounge", "{user}'s lounge"], ['Room {n}', 'Room 1, Room 2…'], ['🔊 {user}', '🔊 name']];
const LIMITS = [0, 2, 3, 4, 5, 8, 10];
const NEEDS = ['ManageChannels', 'MoveMembers', 'ViewChannel', 'Connect'];

const settings = (guildId) => {
  const t = getGuildConfig(guildId).tempVoice || {};
  return { hubId: t.hubId || null, name: NAMES.some(n => n[0] === t.name) ? t.name : NAMES[0][0], limit: LIMITS.includes(t.limit) ? t.limit : 0, rooms: t.rooms || {} };
};
const save = (guildId, s) => setGuildConfig(guildId, { tempVoice: { hubId: s.hubId, name: s.name, limit: s.limit, rooms: s.rooms } });

const recent = new Map();   // user → last creation time, so mashing the hub cannot spam channels
const roomName = (s, member, guild) => {
  const used = new Set(guild.channels.cache.map(c => c.name));
  const base = s.name.replace('{user}', member.displayName).slice(0, 90);
  if (!s.name.includes('{n}')) return used.has(base) && !Object.keys(s.rooms).length ? base : base;
  for (let n = 1; n < 100; n++) { const name = base.replace('{n}', n); if (!used.has(name)) return name; }
  return base.replace('{n}', Date.now() % 1000);
};

async function create(member, hub) {
  const { guild } = member, s = settings(guild.id);
  if (Object.keys(s.rooms).length >= MAX_ROOMS) return null;
  const channel = await guild.channels.create({
    name: roomName(s, member, guild), type: ChannelType.GuildVoice, parent: hub.parentId || undefined, userLimit: s.limit || undefined, bitrate: Math.min(hub.bitrate || 64000, guild.maximumBitrate),
    permissionOverwrites: [...hub.permissionOverwrites.cache.values().map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
      { id: member.id, type: 1, allow: [P.ManageChannels, P.MoveMembers, P.Connect, P.ViewChannel] }],
    reason: `Join to create: ${member.user.tag}`,
  });
  s.rooms[channel.id] = member.id; save(guild.id, s);
  try { await member.voice.setChannel(channel, 'Join to create'); }
  catch { await remove(guild, channel.id); return null; }       // they left before the move: do not leave an empty room behind
  return channel;
}

async function remove(guild, channelId) {
  const s = settings(guild.id);
  delete s.rooms[channelId]; save(guild.id, s);
  const ch = guild.channels.cache.get(channelId);
  if (ch) await ch.delete('Join to create: room is empty').catch(err => log('WARN', 'Could not delete an empty voice room', { guild: guild.name, err }));
}

/** Called for every voice state change. */
async function onVoice(oldState, newState) {
  const guild = newState.guild || oldState.guild, s = settings(guild.id);
  if (!s.hubId && !Object.keys(s.rooms).length) return;
  try {
    if (oldState.channelId && s.rooms[oldState.channelId] && oldState.channelId !== newState.channelId) {
      const ch = guild.channels.cache.get(oldState.channelId);
      if (!ch || !ch.members.filter(m => !m.user.bot).size) await remove(guild, oldState.channelId);
    }
    if (newState.channelId && newState.channelId === s.hubId && newState.member && !newState.member.user.bot) {
      const last = recent.get(newState.id) || 0;
      if (Date.now() - last < COOLDOWN_MS) { await newState.disconnect('Join to create: too fast').catch(() => {}); return; }
      recent.set(newState.id, Date.now());
      const me = guild.members.me, hub = newState.channel;
      if (!me?.permissions.has(NEEDS.filter(n => n !== 'ViewChannel' && n !== 'Connect'))) return;
      await create(newState.member, hub);
    }
  } catch (err) { log('WARN', 'Join to create failed', { guild: guild.name, err }); }
}

/** At startup: forget rooms that no longer exist and delete any that are empty. */
async function sweep(client) {
  for (const guild of client.guilds.cache.values()) {
    const s = settings(guild.id);
    for (const id of Object.keys(s.rooms)) {
      const ch = guild.channels.cache.get(id);
      if (!ch) { delete s.rooms[id]; save(guild.id, s); }
      else if (!ch.members.filter(m => !m.user.bot).size) await remove(guild, id);
    }
  }
}

module.exports = { NAMES, LIMITS, NEEDS, MAX_ROOMS, settings, save, create, remove, onVoice, sweep };
