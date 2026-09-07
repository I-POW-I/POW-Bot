const {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const { log }              = require('../src/logger');
const { run, selectOne, selectAll } = require('../src/database');
const { parseStreamerUrl } = require('../src/platforms/parseUrl');
const { resolveHandle: resolveYouTube, getDisplayName: ytDisplayName } = require('../src/platforms/youtube');
const { getDisplayName: twitchDisplayName } = require('../src/platforms/twitch');

const EMOJI = { kick: '🟢', twitch: '🟣', youtube: '🔴' };
const NAMES = { kick: 'Kick', twitch: 'Twitch', youtube: 'YouTube' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('streamers')
    .setDescription('Watch streamers for go-live notifications')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a streamer to watch — paste their channel link')
        .addStringOption(opt =>
          opt.setName('url')
            .setDescription('Channel link — e.g. https://kick.com/xqc or https://twitch.tv/shroud')
            .setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to post live notifications in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('Role to ping when they go live (optional)')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('display_name')
            .setDescription('Override the display name shown in embeds (optional)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Stop watching a streamer — pick from your current list')
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all streamers setup for gone-live notifications')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add')    return addStreamer(interaction);
    if (sub === 'remove') return removeStreamer(interaction);
    return listStreamers(interaction);
  },
};

// ── /streamers add ────────────────────────────────────────────────────────────
async function addStreamer(interaction) {
  const { guild, member } = interaction;
  const input        = interaction.options.getString('url');
  const channel       = interaction.options.getChannel('channel');
  const role          = interaction.options.getRole('role');
  const overrideName  = interaction.options.getString('display_name') || null;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const parsed = parseStreamerUrl(input);
  if (!parsed) {
    return interaction.editReply({
      content: [
        '❌ Couldn\'t recognise that link. Supported formats:',
        '• `https://kick.com/username`',
        '• `https://twitch.tv/username`',
        '• `https://youtube.com/@handle` or `https://youtube.com/channel/UCxxxxxxx`',
      ].join('\n'),
    });
  }

  let { platform, username, displayHint } = parsed;

  if (platform === 'youtube' && parsed.needsResolve) {
    await interaction.editReply({ content: `🔍 Resolving YouTube channel...` });
    if (!process.env.YOUTUBE_API_KEY) {
      return interaction.editReply({
        content: '❌ `YOUTUBE_API_KEY` is not set. Add it in Discloud environment variables.',
      });
    }
    const channelId = await resolveYouTube(username);
    if (!channelId) {
      return interaction.editReply({
        content: `❌ Couldn't find a YouTube channel for **${username}**. Try using the direct channel link:\n\`https://youtube.com/channel/UCxxxxxxx\``,
      });
    }
    username = channelId;
  }

  const existing = selectOne(
    'SELECT id FROM streamer_subscriptions WHERE guild_id = ? AND platform = ? AND username = ?',
    [guild.id, platform, username]
  );
  if (existing) {
    return interaction.editReply({ content: `❌ That streamer is already being watched in this server.` });
  }

  const botMember = await guild.members.fetchMe();
  if (!channel.permissionsFor(botMember).has(['SendMessages', 'EmbedLinks'])) {
    return interaction.editReply({
      content: `❌ I don't have **Send Messages** and **Embed Links** in <#${channel.id}>.`,
    });
  }

  let displayName = overrideName;
  if (!displayName) {
    await interaction.editReply({ content: `🔍 Fetching streamer info...` });
    if (platform === 'twitch') {
      displayName = await twitchDisplayName(username).catch(() => null);
    } else if (platform === 'youtube') {
      displayName = await ytDisplayName(username).catch(() => null);
    }
    displayName = displayName || displayHint || username;
  }

  run(
    `INSERT INTO streamer_subscriptions
      (guild_id, platform, username, display_name, discord_channel_id, role_id, is_live)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [guild.id, platform, username, displayName, channel.id, role?.id || null]
  );

  log('INFO', 'Streamer added', { guild: guild.name, platform, username, displayName, by: member.user.tag });

  const roleStr = role ? ` · pinging <@&${role.id}>` : '';
  return interaction.editReply({
    content: `✅ Now watching **${displayName}** on **${NAMES[platform]}**.\nNotifications will post in <#${channel.id}>${roleStr}.`,
  });
}

// ── /streamers remove ─────────────────────────────────────────────────────────
async function removeStreamer(interaction) {
  const { guild } = interaction;

  const subs = selectAll(
    'SELECT * FROM streamer_subscriptions WHERE guild_id = ? ORDER BY platform, display_name, username',
    [guild.id]
  );

  if (subs.length === 0) {
    return interaction.reply({
      content: '📭 No streamers are being watched in this server. Use `/streamers add` to add one.',
      flags: [MessageFlags.Ephemeral],
    });
  }

  const options = subs.map(s => ({
    label:       `${s.display_name || s.username}`,
    description: `${NAMES[s.platform]} · ${s.is_live === 1 ? '🔴 Currently live' : 'Offline'}`,
    value:       `${s.id}`,
    emoji:       EMOJI[s.platform],
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('remove_streamer_select')
    .setPlaceholder('Pick a streamer to remove...')
    .addOptions(options);

  return interaction.reply({
    content: 'Select the streamer you want to remove:',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: [MessageFlags.Ephemeral],
  });
}

// ── /streamers list ────────────────────────────────────────────────────────────
async function listStreamers(interaction) {
  const { guild } = interaction;

  const subs = selectAll(
    'SELECT * FROM streamer_subscriptions WHERE guild_id = ? ORDER BY platform, display_name, username',
    [guild.id]
  );

  if (subs.length === 0) {
    return interaction.reply({
      content: 'No streamer notifications currently setup. Use `/streamers add` to add one.',
      flags: [MessageFlags.Ephemeral],
    });
  }

  const grouped = { kick: [], twitch: [], youtube: [] };
  for (const sub of subs) {
    if (grouped[sub.platform]) grouped[sub.platform].push(sub);
  }

  const embed = new EmbedBuilder()
    .setTitle('Watched Streamers')
    .setColor(0x5865F2)
    .setFooter({ text: `${subs.length} streamer(s) total` })
    .setTimestamp();

  for (const [platform, list] of Object.entries(grouped)) {
    if (list.length === 0) continue;

    const lines = list.map(s => {
      const name    = s.display_name || s.username;
      const status  = s.is_live === 1 ? '🔴 **LIVE**' : '⚫ Offline';
      const channel = `<#${s.discord_channel_id}>`;
      const role    = s.role_id ? ` <@&${s.role_id}>` : '';
      return `**${name}** — ${status}\n${channel}${role}`;
    }).join('\n\n');

    embed.addFields({
      name:   `${EMOJI[platform]} ${NAMES[platform]}`,
      value:  lines,
      inline: false,
    });
  }

  return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}
