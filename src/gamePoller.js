/**
 * Game alerts polling engine.
 *
 * Game updates     — every 15 minutes (Steam, Minecraft, Riot, RSS — see src/updates/)
 * Epic free games  — every 6 hours
 * Steam and GOG free games — every 3 hours (short-window promos)
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log }            = require('./logger');
const { selectAll, run } = require('./database');
const { getSteamFree, buildSteamFreeEmbed } = require('./platforms/steamFree');
const { getGiveaways, buildGiveawayEmbed } = require('./platforms/giveaways');
const { fetchLatest, isUpdateKey } = require('./updates/sources');
const { buildUpdateCard } = require('./updates/format');
const { getFreeGames } = require('./platforms/epicGames');
const { STORES } = require('./freeGames');

const UPDATE_INTERVAL     = 15 * 60 * 1000;
const EPIC_INTERVAL       =  6 * 60 * 60 * 1000;
const STEAM_FREE_INTERVAL =  3 * 60 * 60 * 1000; // 3h — catches shorter promotions

const EPIC_COLOUR  = 0x0078F2;

function formatTagLine(tags) {
  if (!tags?.length) return null;
  return tags.map((t) => `**${t}**`).join('  ');
}

// ── Reliable channel fetch ─────────────────────────────────────────────────────
// guild.channels.fetch() can return inconsistent objects — use client.channels.fetch() instead
async function fetchChannel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    return channel;
  } catch { return null; }
}

// ── Steam game update embed ────────────────────────────────────────────────────
function buildEpicGameEmbed(game) {
  const endsAt    = game.endsAt
    ? `<t:${Math.floor(new Date(game.endsAt).getTime() / 1000)}:D>`
    : null;
  const priceLine = [
    game.origPrice ? `~~${game.origPrice}~~` : null,
    '**Free**',
    endsAt ? `until ${endsAt}` : null,
  ].filter(Boolean).join(' ');

  const tagLine = formatTagLine(game.tags);
  const desc = [
    game.description || null,
    '',
    priceLine,
    '',
    `[Open in browser ↗](${game.url})`,
    tagLine ? '' : null,
    tagLine,
  ].filter(v => v !== null).join('\n');

  const embed = new EmbedBuilder()
    .setColor(EPIC_COLOUR)
    .setTitle(game.title)
    .setURL(game.url)
    .setDescription(desc)
    .setFooter({ text: 'Epic Games Store • Free Game' });

  if (game.image) embed.setImage(game.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim free game')
      .setURL(game.url)
      .setStyle(ButtonStyle.Link)
  );
  return { embed, row };
}

// ── Check a Steam game subscription ───────────────────────────────────────────
// ── Game updates (every source) ────────────────────────────────────────────────

/** Post one update card to a subscription's channel. */
async function postUpdate(client, sub, update) {
  const channel = await fetchChannel(client, sub.channel_id);
  if (!channel) return false;
  const card = buildUpdateCard({ ...update, game: sub.game_name || update.game });
  await channel.send({ content: sub.role_id ? `<@&${sub.role_id}>` : undefined, ...card });
  return true;
}

const warnedAt = new Map();
const warnOnce = (key, message, ctx) => {
  if (Date.now() - (warnedAt.get(key) || 0) < 3600_000) return;
  warnedAt.set(key, Date.now());
  log('WARN', message, ctx);
};

/** Check every game-update subscription (one fetch per game, shared by all servers watching it). */
async function pollUpdates(client) {
  if (!require('./globalConfig').featureEnabled('gameAlerts')) return;   // global switch (/owner features)
  const subs = selectAll(`SELECT * FROM game_subscriptions WHERE app_id NOT IN ${require('./freeGames').SQL_IDS}`, []);
  const fetched = new Map();   // app_id → update | null | Error

  for (const sub of subs) {
    if (!isUpdateKey(sub.app_id)) continue;

    if (!fetched.has(sub.app_id)) {
      try { fetched.set(sub.app_id, await fetchLatest(sub)); }
      catch (err) { fetched.set(sub.app_id, err); warnOnce(sub.app_id, `Could not read updates for ${sub.game_name}`, { source: sub.app_id, err }); }
      await new Promise(r => setTimeout(r, 1000));
    }
    const update = fetched.get(sub.app_id);
    if (!update || update instanceof Error) continue;

    const id = String(update.id);
    if (sub.last_post_id === id) continue;
    if (update.date && Date.now() - update.date > 7 * 86_400_000) { run('UPDATE game_subscriptions SET last_post_id = ? WHERE id = ?', [id, sub.id]); continue; }   // never announce an old post as new: if numbering ever changes, just remember it
    if (!sub.last_post_id) { run('UPDATE game_subscriptions SET last_post_id = ? WHERE id = ?', [id, sub.id]); continue; }   // no baseline yet: remember, don't spam

    try {
      if (await postUpdate(client, sub, update)) {
        run('UPDATE game_subscriptions SET last_post_id = ? WHERE id = ?', [id, sub.id]);
        log('INFO', `Posted update: ${update.title}`, { game: sub.game_name, guild: sub.guild_id });
      }
    } catch (err) { log('WARN', 'Failed to post a game update', { game: sub.game_name, err }); }
  }
}

async function checkEpicGames(client) {
  if (!require('./globalConfig').featureEnabled('gameAlerts')) return;   // global switch (/owner features)
  const subs = selectAll('SELECT * FROM game_subscriptions WHERE app_id = ?', ['epic']);
  if (!subs.length) return;

  const { current, upcoming } = await getFreeGames();
  if (!current.length) return;

  const currentKey = current.map(g => g.title).sort().join('|');

  for (const sub of subs) {
    if (sub.last_post_id === currentKey) continue;
    try {
      const channel = await fetchChannel(client, sub.channel_id);
      if (!channel) continue;

      const content = sub.role_id ? `<@&${sub.role_id}>` : undefined;

      for (let i = 0; i < current.length; i++) {
        const { embed, row } = buildEpicGameEmbed(current[i]);
        await channel.send({ content: i === 0 ? content : undefined, embeds: [embed], components: [row] });
        if (i < current.length - 1) await new Promise(r => setTimeout(r, 1000));
      }

      if (upcoming.length > 0) {
        const upEmbed = new EmbedBuilder()
          .setColor(EPIC_COLOUR)
          .setTitle('Coming up free on Epic')
          .setDescription(upcoming.map(g => {
            const starts = g.startsAt
              ? `<t:${Math.floor(new Date(g.startsAt).getTime() / 1000)}:D>`
              : 'Soon';
            return `**${g.title}** — free from ${starts}${g.origPrice ? ` (normally ${g.origPrice})` : ''}`;
          }).join('\n'))
          .setFooter({ text: 'Epic Games Store' });
        await channel.send({ embeds: [upEmbed] });
      }

      run('UPDATE game_subscriptions SET last_post_id = ? WHERE id = ?', [currentKey, sub.id]);
      log('INFO', `Posted ${current.length} Epic free game(s)`, { guild: sub.guild_id });
    } catch (err) {
      log('WARN', 'Failed to post Epic free games', { err });
    }
  }
}

// ── Steam and GOG free games ───────────────────────────────────────────────────
/** Post new free-to-keep games for one store ('steam_free' or 'gog_free') to every server that follows it. */
async function checkGiveaways(client, appId) {
  if (!require('./globalConfig').featureEnabled('gameAlerts')) return;   // global switch (/owner features)
  const subs = selectAll('SELECT * FROM game_subscriptions WHERE app_id = ?', [appId]);
  if (!subs.length) return;
  const { label, platform } = STORES[appId];

  // Steam comes straight from the Steam store. GOG uses GamerPower, which lists GOG's own giveaways
  let games;
  if (appId === 'steam_free') {
    games = (await getSteamFree()).map(g => ({ key: g.key, build: async () => buildSteamFreeEmbed(g) }));
  } else {
    const giveaways = await getGiveaways(platform);
    if (!giveaways) { warnOnce('gamerpower', 'GamerPower unreachable, skipping GOG free games', {}); return; }
    games = giveaways.map(g => ({ key: g.id, build: async () => buildGiveawayEmbed(g, label) }));
  }
  if (!games.length) return;

  for (const sub of subs) {
    const seenIds  = (sub.last_post_id || '').split(',').filter(Boolean);
    const newGames = games.filter(g => !seenIds.includes(g.key));
    if (!newGames.length) continue;

    try {
      const channel = await fetchChannel(client, sub.channel_id);
      if (!channel) continue;
      const content = sub.role_id ? `<@&${sub.role_id}>` : undefined;

      for (let i = 0; i < newGames.length; i++) {
        const { embed, row } = await newGames[i].build();
        await channel.send({ content: i === 0 ? content : undefined, embeds: [embed], components: [row] });
        if (i < newGames.length - 1) await new Promise(r => setTimeout(r, 1000));
      }

      const allSeen = [...new Set([...seenIds, ...games.map(g => g.key)])].slice(-200).join(',');
      run('UPDATE game_subscriptions SET last_post_id = ? WHERE id = ?', [allSeen, sub.id]);
      log('INFO', `Posted ${newGames.length} ${label} free game(s)`, { guild: sub.guild_id });
    } catch (err) {
      log('WARN', `Failed to post ${label} free games`, { err });
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────
function startGamePoller(client) {
  log('INFO', 'Game poller started');

  // Game updates (Steam, Minecraft, Riot, RSS) — every 15 minutes
  setTimeout(() => {
    pollUpdates(client);
    setInterval(() => pollUpdates(client), UPDATE_INTERVAL);
  }, 20000);

  // Epic free games — every 6 hours
  setTimeout(() => {
    checkEpicGames(client);
    setInterval(() => checkEpicGames(client), EPIC_INTERVAL);
  }, 30000);

  // Steam and GOG free games — every 3 hours
  setTimeout(() => {
    const both = () => { checkGiveaways(client, 'steam_free'); checkGiveaways(client, 'gog_free'); };
    both();
    setInterval(both, STEAM_FREE_INTERVAL);
  }, 40000);
}

module.exports = { startGamePoller, pollUpdates, checkGiveaways, postUpdate };
