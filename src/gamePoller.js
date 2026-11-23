/**
 * Game alerts polling engine.
 *
 * Game updates     — every 15 minutes (Steam, Minecraft, Riot, Fortnite, Blizzard, RSS — see src/updates/)
 * Epic free games  — every 6 hours
 * Steam free games — every 3 hours (increased from 6 to catch short-window promos)
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log }            = require('./logger');
const { selectAll, run } = require('./database');
const { getAppDetails, getSteamFreeGames } = require('./platforms/steam');
const { getGiveaways, buildGiveawayEmbed } = require('./platforms/giveaways');
const { fetchLatest, isUpdateKey } = require('./updates/sources');
const { buildUpdateCard } = require('./updates/format');
const { getFreeGames } = require('./platforms/epicGames');

const UPDATE_INTERVAL     = 15 * 60 * 1000;
const EPIC_INTERVAL       =  6 * 60 * 60 * 1000;
const STEAM_FREE_INTERVAL =  3 * 60 * 60 * 1000; // 3h — catches shorter promotions

const EPIC_COLOUR  = 0x0078F2;
const STEAM_COLOUR = 0x1B2838;

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
    .setTimestamp()
    .setFooter({ text: 'Epic Games Store • Free Game' });

  if (game.image) embed.setImage(game.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim Free Game')
      .setURL(game.url)
      .setStyle(ButtonStyle.Link)
  );
  return { embed, row };
}

// ── Steam free game embed — one per game ─────────────────────────────────────
function buildSteamFreeEmbed(game, details) {
  const origFormatted = details?.price?.initial
    ? `~~$${(details.price.initial / 100).toFixed(2)}~~`
    : null;
  const expiryLine = game.discountExpiry
    ? `Free until <t:${game.discountExpiry}:D>`
    : 'Free to Keep';

  const desc = [
    details?.description || null,
    '',
    [origFormatted, `**FREE** — ${expiryLine}`].filter(Boolean).join(' '),
    '',
    `[Open in browser ↗](${game.url})`,
  ].filter(v => v !== null).join('\n');

  const embed = new EmbedBuilder()
    .setColor(STEAM_COLOUR)
    .setTitle(game.name)
    .setURL(game.url)
    .setDescription(desc)
    .setTimestamp()
    .setFooter({ text: 'Steam • Free Game' });

  const fields = [];
  if (details?.releaseDate) fields.push({ name: 'Released',  value: details.releaseDate, inline: true });
  if (details?.platforms)   fields.push({ name: 'Platforms', value: details.platforms,   inline: true });
  if (details?.reviews)     fields.push({ name: 'Reviews',   value: details.reviews,     inline: true });
  if (fields.length) embed.addFields(fields);

  const img = details?.screenshots?.[0] || game.headerImage;
  if (img) embed.setImage(img);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim on Steam')
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
  const subs = selectAll("SELECT * FROM game_subscriptions WHERE app_id != 'epic' AND app_id != 'steam_free'", []);
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
          .setTitle('Coming Up Free on Epic')
          .setDescription(upcoming.map(g => {
            const starts = g.startsAt
              ? `<t:${Math.floor(new Date(g.startsAt).getTime() / 1000)}:D>`
              : 'Soon';
            return `**${g.title}** — free from ${starts}${g.origPrice ? ` (normally ${g.origPrice})` : ''}`;
          }).join('\n'))
          .setTimestamp()
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

// ── Check Steam free games ─────────────────────────────────────────────────────
async function checkSteamFreeGames(client) {
  if (!require('./globalConfig').featureEnabled('gameAlerts')) return;   // global switch (/owner features)
  const subs = selectAll('SELECT * FROM game_subscriptions WHERE app_id = ?', ['steam_free']);
  if (!subs.length) return;

  // 1) GamerPower (tracks Steam free-to-keep promotions reliably)   2) fall back to the old Steam store check
  let games;
  const giveaways = await getGiveaways('steam');
  if (giveaways) {
    games = giveaways.map(g => ({ key: g.id, build: async () => buildGiveawayEmbed(g, 'Steam') }));
  } else {
    warnOnce('gamerpower', 'GamerPower unreachable — using the direct Steam check for free games', {});
    games = (await getSteamFreeGames().catch(() => [])).map(g => ({
      key: String(g.appid),
      build: async () => buildSteamFreeEmbed(g, await getAppDetails(g.appid).catch(() => null)),
    }));
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
      log('INFO', `Posted ${newGames.length} Steam free game(s)`, { guild: sub.guild_id });
    } catch (err) {
      log('WARN', 'Failed to post Steam free games', { err });
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────
function startGamePoller(client) {
  log('INFO', 'Game poller started');

  // Game updates (Steam, Minecraft, Riot, Fortnite, Blizzard, RSS) — every 15 minutes
  setTimeout(() => {
    pollUpdates(client);
    setInterval(() => pollUpdates(client), UPDATE_INTERVAL);
  }, 20000);

  // Epic free games — every 6 hours
  setTimeout(() => {
    checkEpicGames(client);
    setInterval(() => checkEpicGames(client), EPIC_INTERVAL);
  }, 30000);

  // Steam free games — every 3 hours
  setTimeout(() => {
    checkSteamFreeGames(client);
    setInterval(() => checkSteamFreeGames(client), STEAM_FREE_INTERVAL);
  }, 40000);
}

module.exports = { startGamePoller, pollUpdates, checkSteamFreeGames, postUpdate };
