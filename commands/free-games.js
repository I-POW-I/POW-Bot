/**
 * /free-games — free game alerts for Epic Games Store + Steam.
 *
 * Subcommands:
 *   now    — show the games that are free right now (Epic + Steam)
 *   setup  — post free game alerts in a channel (both platforms at once)
 *   edit   — change the channel or the ping role
 *   remove — stop the alerts
 *   status — show where alerts are going
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags,
  ChannelType, PermissionFlagsBits, InteractionContextType,
} = require('discord.js');
const { log }                       = require('../src/logger');
const diagnostics_audit = (e) => require('../src/diagnostics').audit(e);
const { run, selectOne, selectAll } = require('../src/database');
const { getFreeGames }      = require('../src/platforms/epicGames');
const { getSteamFreeGames, getAppDetails } = require('../src/platforms/steam');

const EPIC_COLOUR  = 0x0078F2;
const STEAM_COLOUR = 0x1B2838;
const TAG_DOTS     = ['🔴', '🟡', '🟢', '🔵', '🟣', '🟠'];

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
    ? game.tags.map((t, i) => `${TAG_DOTS[i % TAG_DOTS.length]} **${t}**`).join('  ')
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
    .setTimestamp()
    .setFooter({ text: 'Epic Games Store • Free Game' });

  if (game.image) embed.setImage(game.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim on Epic')
      .setURL(game.url)
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Link)
  );

  return { embed, row };
}

function steamEmbed(game, details) {
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
  if (fields.length) embed.addFields(fields);

  const img = details?.screenshots?.[0] || game.headerImage;
  if (img) embed.setImage(img);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim on Steam')
      .setURL(game.url)
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Link)
  );

  return { embed, row };
}

async function showCurrent(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  // Fetch both platforms in parallel
  const [epicData, steamGames] = await Promise.all([
    getFreeGames(),
    getSteamFreeGames(),
  ]);

  const epicCurrent  = epicData.current  || [];
  const epicUpcoming = epicData.upcoming || [];

  if (!epicCurrent.length && !steamGames.length) {
    return interaction.editReply({
      content: '🎮 No free games available right now on Epic or Steam. Check back soon!',
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
      .setTitle('⏳ Coming Up Free on Epic')
      .setDescription(
        epicUpcoming.map(g => {
          const starts = g.startsAt
            ? `<t:${Math.floor(new Date(g.startsAt).getTime() / 1000)}:D>`
            : 'Soon';
          return `**${g.title}** — free from ${starts}${g.origPrice ? ` (normally ${g.origPrice})` : ''}`;
        }).join('\n')
      )
      .setTimestamp()
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
    const details = await getAppDetails(game.appid).catch(() => null);
    const { embed, row } = steamEmbed(game, details);
    await send(embed, row);
  }

  // If nothing posted at all (shouldn't happen but just in case)
  if (firstReply) {
    await interaction.editReply({ content: '🎮 No free games found right now.' });
  }
}

const FREE_APPS = ['epic', 'steam_free'];
const FREE_NAMES = { epic: 'Epic Games Free Games', steam_free: 'Steam Free Games' };

const freeRows = (guildId) => selectAll(
  "SELECT * FROM game_subscriptions WHERE guild_id = ? AND app_id IN ('epic', 'steam_free')", [guildId]
);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('free-games')
    .setDescription('Free game alerts for Epic Games Store and Steam')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(sub => sub.setName('now').setDescription('Show the games that are free right now'))
    .addSubcommand(sub => sub.setName('setup').setDescription('Post free game alerts in a channel (Epic and Steam)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel for the alerts').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Role to ping (optional)')))
    .addSubcommand(sub => sub.setName('edit').setDescription('Change the alert channel or ping role')
      .addChannelOption(o => o.setName('channel').setDescription('New channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('New ping role — leave empty to remove the ping')))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop free game alerts in this server'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show where free game alerts are posted')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'now') return showCurrent(interaction);

    // Everything else changes server settings → Manage Server
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** to change free game alerts.', flags: [MessageFlags.Ephemeral] });
    }
    const { guild } = interaction;

    if (sub === 'setup' || sub === 'edit') {
      const channel = interaction.options.getChannel('channel');
      const role    = interaction.options.getRole('role');
      const me      = guild.members.me;
      const perms   = channel.permissionsFor(me);
      const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter(p => !perms?.has(PermissionFlagsBits[p])).map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2'));
      if (missing.length) {
        return interaction.reply({ content: `I can't post in <#${channel.id}> — I'm missing: **${missing.join(', ')}**. Fix the channel permissions and try again.`, flags: [MessageFlags.Ephemeral] });
      }
      if (sub === 'edit' && !freeRows(guild.id).length) {
        return interaction.reply({ content: 'Free game alerts are not set up yet — use `/free-games setup` first.', flags: [MessageFlags.Ephemeral] });
      }

      const set = [];
      for (const appId of FREE_APPS) {
        const existing = selectOne('SELECT id FROM game_subscriptions WHERE guild_id = ? AND app_id = ?', [guild.id, appId]);
        if (existing) {
          run('UPDATE game_subscriptions SET channel_id = ?, role_id = ? WHERE id = ?', [channel.id, role?.id || null, existing.id]);
          set.push(`${appId === 'epic' ? '🎮 Epic' : '🎯 Steam'} (updated)`);
        } else {
          run('INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id) VALUES (?, ?, ?, ?, ?)',
            [guild.id, appId, FREE_NAMES[appId], channel.id, role?.id || null]);
          set.push(appId === 'epic' ? '🎮 Epic' : '🎯 Steam');
        }
      }

      diagnostics_audit({ action: sub === 'setup' ? 'Free game alerts set up' : 'Free game alerts changed', actor: interaction.user, guild, details: `→ #${channel.name}${role ? ` · ping @${role.name}` : ''}` });
      return interaction.reply({
        content: [
          `✅ Free game alerts ${sub === 'setup' ? 'set up' : 'updated'} in <#${channel.id}>${role ? ` · pinging <@&${role.id}>` : ''}:`,
          set.map(x => `• ${x}`).join('\n'),
          '',
          'Each game gets its own post. Use `/free-games now` to see what is free right now.',
        ].join('\n'),
        flags: [MessageFlags.Ephemeral],
      });
    }

    if (sub === 'remove') {
      const rows = freeRows(guild.id);
      if (!rows.length) return interaction.reply({ content: '📭 Free game alerts are not set up.', flags: [MessageFlags.Ephemeral] });
      run("DELETE FROM game_subscriptions WHERE guild_id = ? AND app_id IN ('epic', 'steam_free')", [guild.id]);
      diagnostics_audit({ action: 'Free game alerts removed', actor: interaction.user, guild });
      return interaction.reply({ content: '🗑️ Free game alerts removed.', flags: [MessageFlags.Ephemeral] });
    }

    if (sub === 'status') {
      const rows = freeRows(guild.id);
      if (!rows.length) return interaction.reply({ content: '📭 Free game alerts are not set up. Use `/free-games setup`.', flags: [MessageFlags.Ephemeral] });
      const lines = rows.map(r => `${r.app_id === 'epic' ? '🎮' : '🎯'} **${FREE_NAMES[r.app_id]}** → <#${r.channel_id}>${r.role_id ? ` · <@&${r.role_id}>` : ''}`);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎮 Free game alerts').setDescription(lines.join('\n')).setTimestamp()],
        flags: [MessageFlags.Ephemeral],
      });
    }
  },
};
