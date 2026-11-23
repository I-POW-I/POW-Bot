/**
 * Free-to-keep giveaways via GamerPower (https://www.gamerpower.com/api) — free, no API key.
 *
 *   getGiveaways('steam')  → [{ id, title, worth, image, description, instructions, url, endDate, platforms }]
 *                            or null when GamerPower can't be reached (callers fall back to the old Steam check)
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { truncate } = require('../updates/format');
const { fetchJson } = require('../updates/page');

const api = () => process.env.GAMERPOWER_API_URL || 'https://www.gamerpower.com/api';

const cleanTitle = (t) => String(t || '').replace(/\s*\((?:Steam|Epic Games|GOG|Ubisoft|itch\.io)[^)]*\)/i, '').replace(/\s*Giveaway\s*$/i, '').trim();

function parseEnd(s) {
  if (!s || /n\/a/i.test(s)) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return isNaN(t) ? null : t;
}

async function getGiveaways(platform = 'steam', type = 'game') {
  try {
    const data = await fetchJson(`${api()}/giveaways?platform=${encodeURIComponent(platform)}&type=${encodeURIComponent(type)}&sort-by=date`);
    if (!Array.isArray(data)) {
      // GamerPower answers { status: 0, status_message: "No active giveaways found" } when there are none
      return data && (data.status === 0 || /no active/i.test(String(data.status_message || ''))) ? [] : null;
    }
    return data.filter(g => !g.status || /active/i.test(g.status)).map(g => ({
      id: `gp:${g.id}`, title: cleanTitle(g.title), worth: g.worth && !/n\/a/i.test(g.worth) ? g.worth : null,
      image: g.image || g.thumbnail || null, description: g.description || '', instructions: g.instructions || '',
      url: g.open_giveaway_url || g.gamerpower_url || null, endDate: parseEnd(g.end_date), platforms: g.platforms || platform,
    }));
  } catch { return null; }
}

function buildGiveawayEmbed(g, store = 'Steam') {
  const embed = new EmbedBuilder()
    .setColor(0x1B2838)
    .setAuthor({ name: `${store} · Free to keep` })
    .setTitle(truncate(g.title, 250))
    .setDescription(truncate(String(g.description).replace(/\s+/g, ' ').trim(), 350) || null)
    .addFields(
      { name: 'Price', value: `${g.worth ? `~~${g.worth}~~ ` : ''}**Free**`, inline: true },
      { name: 'Offer ends', value: g.endDate ? `<t:${Math.floor(g.endDate / 1000)}:R>` : 'Limited time', inline: true },
    )
    .setFooter({ text: `Free on ${store} · via GamerPower` });
  if (g.url) embed.setURL(g.url);
  if (g.instructions) embed.addFields({ name: 'How to claim', value: truncate(String(g.instructions).replace(/\r/g, '').split('\n').filter(Boolean).slice(0, 3).join('\n'), 400), inline: false });
  if (g.image) embed.setImage(g.image);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(`Claim on ${store}`).setStyle(ButtonStyle.Link).setURL(g.url || 'https://www.gamerpower.com'),
  );
  return { embed, row };
}

module.exports = { getGiveaways, buildGiveawayEmbed, cleanTitle };
