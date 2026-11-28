/**
 * Game Updates Hub — the bot's own Discord server gets a copy of every game update, one channel per game.
 *
 * Set GAME_UPDATES_HUB_GUILD_ID to that server's ID (the bot needs Manage Channels there). The first time a game is seen its
 * channel is created under a "Game Updates" category, and from then on each new patch is posted there once, however many servers
 * follow the game. If the channels are Announcement channels (the server needs Community turned on), anyone can follow them from
 * their own server with Discord's Follow button. Other servers are not affected at all: they keep their own updates channel.
 */

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { log }          = require('./logger');
const globalConfig     = require('./globalConfig');
const { buildUpdateCard } = require('./updates/format');

const CATEGORY = 'Game Updates';
const PER_CATEGORY = 50;                                  // Discord's limit of channels in one category
const guildId = () => (process.env.GAME_UPDATES_HUB_GUILD_ID || '').trim();
const enabled = () => /^\d{15,25}$/.test(guildId());

const slug = (name) => String(name || 'game').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'game';
const data = () => { const c = globalConfig.get(); c.gameHub = c.gameHub || {}; c.gameHub.channels = c.gameHub.channels || {}; c.gameHub.seen = c.gameHub.seen || {}; return c.gameHub; };

const warned = new Map();
const warnOnce = (key, message, ctx) => { if (Date.now() - (warned.get(key) || 0) < 3600_000) return; warned.set(key, Date.now()); log('WARN', message, { tag: 'GAMES', ...ctx }); };

/** The category with room for another channel, made if needed ("Game Updates", then "Game Updates 2"…). */
async function categoryWithRoom(guild) {
  const cats = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory && (c.name === CATEGORY || /^Game Updates \d+$/.test(c.name))).values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const cat of cats) if (cat.children.cache.size < PER_CATEGORY) return cat;
  return guild.channels.create({ name: cats.length ? `${CATEGORY} ${cats.length + 1}` : CATEGORY, type: ChannelType.GuildCategory, reason: 'Game Updates Hub' });
}

/** The channel for one game: the remembered one, one with the same name, or a new read-only one. */
async function channelFor(guild, appId, gameName) {
  const store = data();
  const known = store.channels[appId] && guild.channels.cache.get(store.channels[appId]);
  if (known) return known;
  const name = slug(gameName);
  let channel = guild.channels.cache.find(c => c.name === name && c.isTextBased() && c.parent?.name?.startsWith(CATEGORY));
  if (!channel) {
    const parent = await categoryWithRoom(guild);
    const announce = guild.features.includes('COMMUNITY');
    channel = await guild.channels.create({
      name, parent: parent.id,
      type: announce ? ChannelType.GuildAnnouncement : ChannelType.GuildText,
      topic: `Patch notes and updates for ${gameName}`,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }],
      reason: `Game Updates Hub: ${gameName}`,
    });
    log('INFO', `Created hub channel for ${gameName}`, { tag: 'GAMES', channel: `#${name}` });
  }
  globalConfig.update(c => { c.gameHub = c.gameHub || {}; c.gameHub.channels = c.gameHub.channels || {}; c.gameHub.channels[appId] = channel.id; });
  return channel;
}

/**
 * Copy one update into the hub. Called once per game per check (not once per server).
 * The first time a game is seen only its channel is made and the post is remembered, so nothing old is posted as new.
 * Returns true when a post was made.
 */
async function mirror(client, appId, gameName, update, keys, { force = false } = {}) {
  if (!enabled() || !update) return false;
  const guild = client.guilds.cache.get(guildId());
  if (!guild) { warnOnce('missing', 'The Game Updates Hub server could not be found. Check GAME_UPDATES_HUB_GUILD_ID and that the bot is in it', {}); return false; }
  try {
    const store = data();
    const seen = store.seen[appId] || [];
    const channel = await channelFor(guild, appId, gameName);
    const fresh = !keys.some(k => seen.includes(k));
    const remember = () => globalConfig.update(c => { c.gameHub.seen[appId] = [...keys, ...seen.filter(k => !keys.includes(k))].slice(0, 12); });
    if (!fresh && !force) return false;
    const old = update.date && Date.now() - update.date > 7 * 86_400_000;
    if (!force && (!seen.length || old)) { remember(); return false; }
    const message = await channel.send({ ...buildUpdateCard({ ...update, game: gameName }), showpiece: 'links' });
    if (channel.type === ChannelType.GuildAnnouncement) await message.crosspost().catch(() => {});   // reaches servers that follow the channel
    remember();
    log('INFO', `Mirrored update to the hub: ${update.title}`, { tag: 'GAMES', game: gameName });
    return true;
  } catch (err) {
    warnOnce(`fail:${appId}`, `Could not post ${gameName} to the Game Updates Hub`, { game: gameName, err });
    return false;
  }
}

/** For /owner: whether it is on, and how many games have a channel. */
function status() {
  return { enabled: enabled(), guildId: guildId() || null, channels: Object.keys(data().channels).length };
}

module.exports = { mirror, status, enabled, slug };
