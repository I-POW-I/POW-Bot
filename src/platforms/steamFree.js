/**
 * Free to keep games on Steam, straight from the Steam store (no third party, so nothing that needs another account).
 *
 * A game counts when Steam lists it at 100% off: the offer is a real, limited time discount on the store page.
 * Each game is returned with what the post shows: price, release date, reviews and platforms.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSteamFreeGames, getAppDetails, getReviews } = require('./steam');

const STEAM_LOGO = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png';

/** "$9.99" from Steam's own formatted price, or from the discount listing when that is missing. */
const worth = (details, game) => details?.price?.initial_formatted || (game.originalPrice ? `$${(game.originalPrice / 100).toFixed(2)}` : null);

/** "Very Positive (92% of 316 are positive)" */
function reviewText(r) {
  if (!r || !r.total) return 'No user reviews yet';
  const pct = Math.round((r.positive / r.total) * 100);
  return `${r.label || 'Reviews'} (${pct}% of ${r.total.toLocaleString('en-GB')} are positive)`;
}

/** Everything the post needs for one game. Missing details are simply left out of the post. */
async function describe(game) {
  const [details, reviews] = await Promise.all([getAppDetails(game.appid).catch(() => null), getReviews(game.appid).catch(() => null)]);
  return {
    key: String(game.appid), appid: game.appid, name: details?.name || game.name, url: game.url, image: details?.headerImage || game.headerImage,
    worth: worth(details, game), releaseDate: details?.releaseDate || null, platforms: details?.platforms || null,
    reviews: reviewText(reviews), expires: game.discountExpiry || null,
  };
}

/** Games free to keep on Steam right now, with details. Empty when there are none or Steam can't be reached. */
async function getSteamFree() {
  const games = await getSteamFreeGames();
  const out = [];
  for (const g of games.slice(0, 10)) out.push(await describe(g));
  return out;
}

function buildSteamFreeEmbed(g) {
  const embed = new EmbedBuilder()
    .setColor(0x1B2838)
    .setAuthor({ name: 'Steam' })
    .setTitle(`Free Game: ${g.name}`.slice(0, 256))
    .setURL(g.url)
    .setThumbnail(STEAM_LOGO)
    .addFields(
      { name: 'Price', value: `${g.worth ? `~~${g.worth}~~ ` : ''}**FREE**`, inline: true },
      ...(g.releaseDate ? [{ name: 'Release Date', value: g.releaseDate, inline: true }] : []),
      { name: 'All Reviews', value: g.reviews, inline: true },
      ...(g.platforms ? [{ name: 'Supported Platforms', value: g.platforms, inline: false }] : []),
      ...(g.expires ? [{ name: 'Offer ends', value: `<t:${g.expires}:R>`, inline: false }] : []),
    );
  if (g.image) embed.setImage(g.image);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Claim on Steam').setStyle(ButtonStyle.Link).setURL(g.url));
  return { embed, row };
}

module.exports = { getSteamFree, buildSteamFreeEmbed, reviewText };
