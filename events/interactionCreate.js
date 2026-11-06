const { 
  Events, 
  PermissionFlagsBits, 
  MessageFlags, 
  ActivityType, 
  UserSelectMenuBuilder, 
  ChannelSelectMenuBuilder, 
  ChannelType, 
  ButtonBuilder, 
  ButtonStyle, 
  ActionRowBuilder 
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { log }                     = require('../src/logger');
const store                       = require('../src/connectionStore');
const { attachDisconnectHandler } = require('../src/heartbeat');
const {
  updatePanel, buildMemberEmbed, buildStatsEmbed,
  buildChannelSelectRow, buildUserSelectRow,
} = require('../src/statusUpdater');
const { setLastChannel, clearLastChannel, setStats, getVerifyRoleId, getBotControlRoleId } = require('../src/guildConfig');
const { attachSilencePlayer, stopSilencePlayer } = require('../src/audioPlayer');
const { run, selectOne, selectAll } = require('../src/database');
const { joinTimes }               = require('../src/memberTracker');
const diagnostics                = require('../src/diagnostics');
const globalConfig               = require('../src/globalConfig');
const { isBotAdmin }             = require('../src/permissions');

const HEALTHY = [
  VoiceConnectionStatus.Ready,
  VoiceConnectionStatus.Signalling,
  VoiceConnectionStatus.Connecting,
];

const PLATFORM_NAMES = { kick: 'Kick', twitch: 'Twitch', youtube: 'YouTube' };

// ── Shared join logic ─────────────────────────────────────────────────────────
async function joinChannel(targetChannel, guild, member, client, interaction) {
  const existingConn = getVoiceConnection(guild.id);
  if (existingConn) {
    if (HEALTHY.includes(existingConn.state.status)) {
      const entry = store.getEntry(guild.id);
      return interaction.reply({
        content: `I am already connected to **${entry?.channelName || 'a voice channel'}**. Ask a admin to use the Leave button first.`,
        flags: [MessageFlags.Ephemeral],
      });
    }
    try { existingConn.destroy(); } catch (_) {}
    store.clearConnection(guild.id);
    stopSilencePlayer(guild.id);
  }

  try {
    const connection = joinVoiceChannel({
      channelId:      targetChannel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       true,
      selfMute:       false,
    });

    attachDisconnectHandler(connection, guild.name, targetChannel.name);
    attachSilencePlayer(connection, guild.id);

    store.setConnection(guild.id, {
      channelId:   targetChannel.id,
      channelName: targetChannel.name,
      guildName:   guild.name,
    });
    setLastChannel(guild.id, targetChannel.id);

    const entry = store.getEntry(guild.id);
    setStats(guild.id, { joinedAt: entry.joinedAt, reconnectCount: 0 });

    client.user.setPresence({
      status: 'dnd',
      activities: [{ name: `🔊 ${targetChannel.name}`, type: ActivityType.Custom }],
    });

    log('VOICE', 'Joined channel', { guild: guild.name, channel: targetChannel.name, by: member.user.tag });
    await updatePanel(client);

    return interaction.reply({ content: `✅ Joined **${targetChannel.name}**.`, flags: [MessageFlags.Ephemeral] });
  } catch {
    return interaction.reply({
      content: 'Failed to join — check I have the **Connect** permission.',
      flags: [MessageFlags.Ephemeral],
    });
  }
}


// Modules that own their own buttons / menus / modals. Each returns true when it handled the interaction.
const DELEGATES = [
  () => require('../src/ownerMonitor').handleComponent,   // alert-DM buttons + restart confirmation
  () => require('../commands/owner').handleComponent,     // /owner panels, announcements, bans
  () => require('../src/setup').handleInteraction,        // /setup screens
  () => require('../src/verification').handleInteraction, // verify button, human check, "Why?"
  () => require('../commands/help').handleComponent,      // /help category menu
];

async function handle(interaction, client) {

    // ── Autocomplete (used by /owner) ─────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd?.autocomplete) { try { await cmd.autocomplete(interaction, client); } catch { /* suggestions are best-effort */ } }
      return;
    }

    // ── Components owned by other modules ─────────────────────────────────────
    for (const load of DELEGATES) {
      if (await load()(interaction, client)) return;
    }

    // ── Slash commands ────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      // ── Log every slash command use to console and command log channel ────────
      function resolveArg(o, guild) {
        if (o.type === 1 || o.type === 2) return '[' + o.name + ']';
        if (o.type === 7) { const ch = guild?.channels.cache.get(String(o.value)); return o.name + ':#' + (ch?.name || o.value); }
        if (o.type === 8) { const r = guild?.roles.cache.get(String(o.value)); return o.name + ':@' + (r?.name || o.value); }
        if (o.type === 6) { const m = guild?.members.cache.get(String(o.value)); return o.name + ':@' + (m?.user?.username || o.value); }
        return o.value !== undefined ? o.name + ':' + o.value : o.name;
      }
      const cmdArgs = interaction.options?.data?.map(o => resolveArg(o, interaction.guild)).join(' ') || '';
      log('INFO', `/${interaction.commandName}${cmdArgs ? ' ' + cmdArgs : ''}`, {
        user:    interaction.user.tag,
        guild:   interaction.guild?.name || 'DM',
        channel: interaction.channel?.name || '—',
      });

      // Post to command log channel if configured
      const { getLogChannel } = require('../src/guildConfig');
      const cmdLogId = interaction.guild ? getLogChannel(interaction.guild.id, 'commands') : null;
      if (cmdLogId) {
        try {
          const { EmbedBuilder } = require('discord.js');
          const cmdCh = await client.channels.fetch(cmdLogId).catch(() => null);
          if (cmdCh?.isTextBased()) {
            await cmdCh.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0x5865F2)
                  .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                  .setTitle(`/${interaction.commandName}`)
                  .addFields(
                    { name: 'Used By', value: `${interaction.member || interaction.user} — ${interaction.user.tag}`, inline: true },
                    { name: 'Channel', value: interaction.channel ? `<#${interaction.channel.id}>` : '—',            inline: true },
                    ...(cmdArgs ? [{ name: 'Options', value: cmdArgs, inline: false }] : []),
                  )
                  .setTimestamp(),
              ],
            });
          }
        } catch { /* command log failure is non-critical */ }
      }

      try {
        await command.execute(interaction, client);
      } catch (err) {
        log('ERROR', `Error in /${interaction.commandName}`, { guild: interaction.guild?.name || 'DM', user: interaction.user.tag, err });
        await replyFailure(interaction);
      }
      return;
    }


    
    // ── Channel select (voice channel picker for Join) ─────────────────────────
    if (interaction.isChannelSelectMenu() && interaction.customId === 'bot_join_channel') {
      const targetChannel = interaction.channels.first();
      if (!targetChannel?.isVoiceBased()) {
        return interaction.reply({ content: 'That is not a voice channel.', flags: [MessageFlags.Ephemeral] });
      }
      return joinChannel(targetChannel, interaction.guild, interaction.member, client, interaction);
    }

    // ── User select (member lookup) ───────────────────────────────────────────
    if (interaction.isUserSelectMenu() && interaction.customId === 'bot_lookup_user') {
      const { guild } = interaction;
      const user   = interaction.users.first();
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        return interaction.reply({ content: 'Could not find that member.', flags: [MessageFlags.Ephemeral] });
      }
      return interaction.reply({
        embeds: [buildMemberEmbed(member, guild)],
        flags:  [MessageFlags.Ephemeral],
      });
    }

    // ── Game alert: add (game selected from search results) ──────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'gamealert_add_select') {
      const { guild, member } = interaction;
      const [appId, channelId, roleId] = interaction.values[0].split('|||');
      const gameName = interaction.component.options.find(o => o.value === interaction.values[0])?.label || `App ${appId}`;

      const existing = selectOne(
        'SELECT id FROM game_subscriptions WHERE guild_id = ? AND app_id = ?',
        [guild.id, appId]
      );

      if (existing) {
        return interaction.update({
          content: `> **${gameName}** is already being tracked in this server.`,
          components: [],
        });
      }

      const { GAME_COLOURS } = require('../commands/game-updates');
      const color = GAME_COLOURS?.[parseInt(appId)] || null;

      run(
        'INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id, color) VALUES (?, ?, ?, ?, ?, ?)',
        [guild.id, appId, gameName, channelId, roleId || null, color || null]
      );

      log('INFO', 'Game alert added', { guild: guild.name, game: gameName, appId, by: member.user.tag });

      const roleStr = roleId ? ` · pinging <@&${roleId}>` : '';
      return interaction.update({
        content: `✅ Now tracking **${gameName}** — updates will post in <#${channelId}>${roleStr}.`,
        components: [],
      });
    }

    // ── Game alert: edit (change channel/role) ───────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'gamealert_edit_select') {
      const { guild, member } = interaction;
      const [subId, channelId, roleId] = interaction.values[0].split('|||');
      const sub = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [subId, guild.id]);

      if (!sub) {
        return interaction.update({ content: '❌ Not found — may have already been removed.', components: [] });
      }

      run('UPDATE game_subscriptions SET channel_id = ?, role_id = ? WHERE id = ?',
        [channelId, roleId || null, sub.id]);

      log('INFO', 'Game alert channel updated', { guild: guild.name, game: sub.game_name, by: member.user.tag });

      const NAMES = { epic: 'Epic Free Games', steam_free: 'Steam Free Games' };
      const name  = NAMES[sub.app_id] || sub.game_name || sub.app_id;
      const roleStr = roleId ? ` · pinging <@&${roleId}>` : '';

      return interaction.update({
        content:    `✅ **${name}** will now post in <#${channelId}>${roleStr}.`,
        components: [],
      });
    }

    // ── Game alert: remove ────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'gamealert_remove_select') {
      const { guild, member } = interaction;
      const subId    = interaction.values[0];
      const sub      = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [subId, guild.id]);

      if (!sub) {
        return interaction.update({ content: 'Not found — may have already been removed.', components: [] });
      }

      run('DELETE FROM game_subscriptions WHERE id = ?', [subId]);
      log('INFO', 'Game alert removed', { guild: guild.name, game: sub.game_name, by: member.user.tag });

      return interaction.update({
        content: `✅ No longer tracking **${sub.game_name}**.`,
        components: [],
      });
    }

    // ── Game alert: test (game selected) ─────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'gamealert_test_select') {
      const subId = interaction.values[0];
      const sub   = selectOne('SELECT * FROM game_subscriptions WHERE id = ?', [subId]);
      if (!sub) return interaction.update({ content: '❌ Not found.', components: [] });
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { runTest } = require('../commands/game-updates');
      return runTest(interaction, sub, true);
    }

    // ── Remove streamer select ────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'remove_streamer_select') {
      const { guild, member } = interaction;
      
      // 🛠️ FIX: Grab the first element out of the selection array string mapping
      const subId = interaction.values[0]; 
      
      const sub   = selectOne('SELECT * FROM streamer_subscriptions WHERE id = ? AND guild_id = ?', [subId, guild.id]);

      if (!sub) {
        return interaction.update({ content: 'Not found — may have already been removed.', components: [] });
      }

      run('DELETE FROM streamer_subscriptions WHERE id = ?', [subId]);
      log('INFO', 'Streamer removed', { guild: guild.name, platform: sub.platform, username: sub.username, by: member.user.tag });
      if (sub.platform === 'twitch') require('../src/platforms/twitchEventSub').requestSync();

      return interaction.update({
        content:    `✅ No longer watching **${sub.display_name || sub.username}** on **${PLATFORM_NAMES[sub.platform]}**.`,
        components: [],
      });
    }


    
    if (!interaction.isButton()) return;

    const { guild, member } = interaction;

    // ── Log button use to console and command log channel ─────────────────────
    { // log every button press
      log('INFO', `Button: ${interaction.customId}`, {
        user:  interaction.user.tag,
        guild: interaction.guild?.name || 'DM',
      });
      if (interaction.guild) {
        try {
          const { getLogChannel: _glc } = require('../src/guildConfig');
          const { EmbedBuilder: _EB2 } = require('discord.js');
          const btnLogId = _glc(interaction.guild.id, 'commands');
          if (btnLogId) {
            const btnCh = await client.channels.fetch(btnLogId).catch(() => null);
            if (btnCh?.isTextBased()) {
              const BUTTON_LABELS = {
                bot_join: '🔊 Join', bot_leave: '👋 Leave',
                bot_myinfo: '👤 My Info', bot_lookup: '🔍 Lookup',
                bot_info: 'ℹ️ Bot Info',
              };
              const label = BUTTON_LABELS[interaction.customId] || interaction.customId;
              await btnCh.send({
                embeds: [
                  new _EB2()
                    .setColor(0x9C59D1)
                    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                    .setTitle(`Button: ${label}`)
                    .addFields(
                      { name: 'Used By', value: `${interaction.member || interaction.user} — ${interaction.user.tag}`, inline: true },
                      { name: 'Channel', value: interaction.channel ? `<#${interaction.channel.id}>` : '—',            inline: true },
                    )
                    .setTimestamp(),
                ],
              });
            }
          }
        } catch { /* non-critical */ }
      }
    }
    const isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);

    // ── Open to everyone ──────────────────────────────────────────────────────

    if (interaction.customId === 'bot_info') {
      const embeds = [buildStatsEmbed(guild.id, client)];
      if (isBotAdmin(interaction.user.id)) embeds.push(...await require('../src/botInfo').buildOwnerEmbeds(client));   // owner-only extras
      return interaction.reply({ embeds, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.customId === 'bot_myinfo') {
      return interaction.reply({
        embeds: [buildMemberEmbed(member, guild)],
        flags:  [MessageFlags.Ephemeral],
      });
    }

    if (interaction.customId === 'bot_lookup') {
      const { buildUserSelectRow } = require('../src/statusUpdater');
      return interaction.reply({
        content:    'Select a member to view their profile:',
        components: [buildUserSelectRow()],
        flags:      [MessageFlags.Ephemeral],
      });
    }

    // ── Role/owner gated ──────────────────────────────────────────────────────
    const botControlRoleId = getBotControlRoleId(guild.id);
    const canControl       = botControlRoleId
      ? member.roles.cache.has(botControlRoleId)
      : guild.ownerId === member.user.id;

    // ── Join — Manage Server ──────────────────────────────────────────────────
    if (interaction.customId === 'bot_join') {
      if (!isAdmin) {
        return interaction.reply({ content: 'You need **Manage Server** to use this.', flags: [MessageFlags.Ephemeral] });
      }
      const targetChannel = member.voice?.channel;
      if (targetChannel?.isVoiceBased()) return joinChannel(targetChannel, guild, member, client, interaction);
      return interaction.reply({
        content:    "You're not in a voice channel. Pick one:",
        components: [buildChannelSelectRow()],
        flags:      [MessageFlags.Ephemeral],
      });
    }

    // ── Leave — role/owner gated ──────────────────────────────────────────────
    if (interaction.customId === 'bot_leave') {
      if (!canControl) {
        return interaction.reply({
          content: botControlRoleId ? `You need the <@&${botControlRoleId}> role.` : 'Only the server owner can use this.',
          flags: [MessageFlags.Ephemeral],
        });
      }
      const conn  = getVoiceConnection(guild.id);
      const entry = store.getEntry(guild.id);
      if (!conn && !entry) return interaction.reply({ content: "Not connected.", flags: [MessageFlags.Ephemeral] });
      if (conn) { try { conn.destroy(); } catch (_) {} }
      stopSilencePlayer(guild.id);
      store.clearConnection(guild.id);
      clearLastChannel(guild.id);
      client.user.setPresence({ status: 'idle', activities: [{ name: 'Sleeping...', type: ActivityType.Custom }] });
      log('VOICE', 'Left via panel', { guild: guild.name, by: member.user.tag });
      await updatePanel(client);
      return interaction.reply({ content: `Disconnected from **${entry?.channelName || 'the voice channel'}**.`, flags: [MessageFlags.Ephemeral] });
    }
}

// ── Safety net, global gates, and the exported handler ───────────────────────

/** Tell the user something went wrong without ever throwing from here. */
async function replyFailure(interaction) {
  try {
    const reply = { content: 'Something went wrong. The bot owner has been notified.', flags: [MessageFlags.Ephemeral] };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  } catch { /* the interaction may have expired — nothing more we can do */ }
}

function describeInteraction(i) {
  if (i.isChatInputCommand()) {
    const group = i.options.getSubcommandGroup(false), sub = i.options.getSubcommand(false);
    return `/${i.commandName}${group ? ' ' + group : ''}${sub ? ' ' + sub : ''}`;
  }
  if (i.isButton())      return `Button: ${i.customId}`;
  if (i.isModalSubmit()) return `Modal: ${i.customId}`;
  if (i.isAutocomplete()) return `Autocomplete: /${i.commandName}`;
  if (i.isAnySelectMenu?.()) return `Menu: ${i.customId}`;
  return 'Interaction';
}

/** Blocked users/servers and maintenance mode. The bot owner and bot admins always pass. */
async function passesGlobalGates(interaction) {
  const uid = interaction.user?.id;
  if (!uid || isBotAdmin(uid)) return true;

  let message = null;
  if (interaction.guildId && globalConfig.isGuildBanned(interaction.guildId)) message = 'This server has been blocked from using this bot.';
  else if (globalConfig.isUserBanned(uid)) message = 'You have been blocked from using this bot.';
  else if (globalConfig.isMaintenance()) message = globalConfig.get().maintenance.message || 'The bot is in maintenance mode. Please try again shortly.';
  if (!message) return true;

  try {
    if (interaction.isAutocomplete()) await interaction.respond([]);
    else await interaction.reply({ content: `🔧 ${message}`, flags: [MessageFlags.Ephemeral] });
  } catch { /* already answered / expired */ }
  return false;
}

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    if (!(await passesGlobalGates(interaction))) return;

    const label = describeInteraction(interaction);
    if (interaction.isChatInputCommand()) { diagnostics.bump('commands'); diagnostics.addBreadcrumb('command', `${label} (${interaction.user.tag} · ${interaction.guild?.name || 'DM'})`); }
    else if (interaction.isButton())      { diagnostics.bump('buttons');  diagnostics.addBreadcrumb('button',  `${label} (${interaction.user.tag} · ${interaction.guild?.name || 'DM'})`); }

    // Everything below runs "inside" this label, so any log line or crash says what triggered it.
    await diagnostics.runWithContext(diagnostics.interactionContext(interaction, label), async () => {
      try {
        await handle(interaction, client);
      } catch (err) {
        log('ERROR', `Unhandled error in ${label}`, { guild: interaction.guild?.name || 'DM', user: interaction.user?.tag, err });
        await replyFailure(interaction);
      }
    });
  },
};
