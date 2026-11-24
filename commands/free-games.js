/**
 * /free-games: shows the games that are free right now on Epic, Steam and GOG.
 * Staff also get a button to the setup page (/setup -> Free game alerts) where the alerts are turned on and off.
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags,
  PermissionFlagsBits, InteractionContextType,
} = require('discord.js');
const { selectOne }                 = require('../src/database');
const { getFreeGames }      = require('../src/platforms/epicGames');
const { getSteamFree, buildSteamFreeEmbed } = require('../src/platforms/steamFree');
const { getGiveaways, buildGiveawayEmbed } = require('../src/platforms/giveaways');
const { SQL_IDS } = require('../src/freeGames');

const EPIC_COLOUR  = 0x0078F2;

function epicEmbed(game) {
  const endsAt   = game.endsAt
    ? `<t:${Math.floor(new Date(game.endsAt).getTime() / 1000)}:D>`
    : null;

  const priceLine = [
    game.origPrice ? `~~${game.origPrice}~~` : null,
    '**Free**',
    endsAt ? `until ${endsAt}` : null,
  ].filter(Boolean).join(' ');

  const tagLine = game.tags?.length
    ? game.tags.map((t) => `**${t}**`).join('  ')
    : null;

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
      .setLabel('Claim on Epic')
      .setURL(game.url)
      .setStyle(ButtonStyle.Link)
  );

  return { embed, row };
}

async function showCurrent(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  // Fetch both platforms in parallel
  const [epicData, steamGames, gogGames] = await Promise.all([
    getFreeGames(),
    getSteamFree(),
    getGiveaways('gog').then(list => list || []),
  ]);

  const epicCurrent  = epicData.current  || [];
  const epicUpcoming = epicData.upcoming || [];

  if (!epicCurrent.length && !steamGames.length && !gogGames.length) {
    return interaction.editReply({
      content: 'No free games available right now on Epic, Steam or GOG. Check back soon.',
    });
  }

  let firstReply = true;

  const send = async (embed, row) => {
    if (firstReply) {
      await interaction.editReply({ embeds: [embed], components: [row] });
      firstReply = false;
    } else {
      await interaction.followUp({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
    }
  };

  // ── Epic free games ───────────────────────────────────────────────────────
  for (const game of epicCurrent) {
    const { embed, row } = epicEmbed(game);
    await send(embed, row);
  }

  // ── Epic upcoming ─────────────────────────────────────────────────────────
  if (epicUpcoming.length > 0) {
    const upEmbed = new EmbedBuilder()
      .setColor(EPIC_COLOUR)
      .setTitle('Coming up free on Epic')
      .setDescription(
        epicUpcoming.map(g => {
          const starts = g.startsAt
            ? `<t:${Math.floor(new Date(g.startsAt).getTime() / 1000)}:D>`
            : 'Soon';
          return `**${g.title}** — free from ${starts}${g.origPrice ? ` (normally ${g.origPrice})` : ''}`;
        }).join('\n')
      )
      .setFooter({ text: 'Epic Games Store' });

    if (firstReply) {
      await interaction.editReply({ embeds: [upEmbed] });
      firstReply = false;
    } else {
      await interaction.followUp({ embeds: [upEmbed], flags: [MessageFlags.Ephemeral] });
    }
  }

  // ── Steam free games ──────────────────────────────────────────────────────
  for (const game of steamGames) {
    const { embed, row } = buildSteamFreeEmbed(game);
    await send(embed, row);
  }

  // ── GOG free games ────────────────────────────────────────────────────────
  for (const game of gogGames) {
    const { embed, row } = buildGiveawayEmbed(game, 'GOG');
    await send(embed, row);
  }

  // If nothing posted at all (shouldn't happen but just in case)
  if (firstReply) {
    await interaction.editReply({ content: 'No free games found right now.' });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('free-games')
    .setDescription('Games that are free right now on Epic, Steam and GOG')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await showCurrent(interaction);

    // Staff also see where this server's alerts go, with a shortcut to the setup page
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;
    const row = selectOne(`SELECT channel_id, role_id FROM game_subscriptions WHERE guild_id = ? AND app_id IN ${SQL_IDS}`, [interaction.guildId]);
    return interaction.followUp({
      content: row ? `Free game alerts are posted in <#${row.channel_id}>${row.role_id ? ` and ping <@&${row.role_id}>` : ''}.` : 'Free game alerts are off for this server.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:free').setLabel('Manage free game alerts').setStyle(ButtonStyle.Primary))],
      flags: [MessageFlags.Ephemeral],
    });
  },
};
