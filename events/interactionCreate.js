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
  updatePanel, buildMemberEmbed,
  buildChannelSelectRow, buildUserSelectRow,
} = require('../src/statusUpdater');
const { setLastChannel, clearLastChannel, setStats, getVerifyRoleId, getBotControlRoleId } = require('../src/guildConfig');
const { attachSilencePlayer, stopSilencePlayer } = require('../src/audioPlayer');
const { run, selectOne, selectAll } = require('../src/database');
const { joinTimes }               = require('../src/memberTracker');

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


module.exports = {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {

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
        log('WARN', `Error in /${interaction.commandName}`, { error: err.message });
        const reply = { content: 'Something went wrong.', flags: [MessageFlags.Ephemeral] };
        interaction.replied || interaction.deferred
          ? await interaction.followUp(reply)
          : await interaction.reply(reply);
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
      const [appId, channelId, roleId] = interaction.values.split('|||');
      const gameName = interaction.component.options.find(o => o.value === interaction.values)?.label || `App ${appId}`;

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

      const { GAME_COLOURS } = require('../commands/gamealerts');
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
      const [subId, channelId, roleId] = interaction.values.split('|||');
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
      const subId    = interaction.values;
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
      const subId = interaction.values;
      const sub   = selectOne('SELECT * FROM game_subscriptions WHERE id = ?', [subId]);
      if (!sub) return interaction.update({ content: '❌ Not found.', components: [] });
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { runTest } = require('../commands/gamealerts');
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

      return interaction.update({
        content:    `✅ No longer watching **${sub.display_name || sub.username}** on **${PLATFORM_NAMES[sub.platform]}**.`,
        components: [],
      });
    }


    
    if (!interaction.isButton()) return;

    const { guild, member } = interaction;

    // ── Log button use to console and command log channel ─────────────────────
    if (interaction.customId !== 'bot_admin_drag_init' && interaction.customId !== 'drag_execute_confirm') {
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
                bot_forceleave: '🔌 Force Leave', bot_refresh: '🔄 Refresh',
                bot_myinfo: '👤 My Info', bot_lookup: '🔍 Lookup',
                bot_verify: '✅ Verify'
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

    // ── Verify button ─────────────────────────────────────────────────────────
    if (interaction.customId === 'bot_verify') {
      const roleId = getVerifyRoleId(guild.id);
      if (!roleId) {
        return interaction.reply({ content: 'Verification not set up. An admin needs to run `/verify setup` first.', flags: [MessageFlags.Ephemeral] });
      }
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        return interaction.reply({ content: 'The verify role no longer exists — contact an admin.', flags: [MessageFlags.Ephemeral] });
      }
      if (member.roles.cache.has(roleId)) {
        return interaction.reply({ content: 'You are already verified.', flags: [MessageFlags.Ephemeral] });
      }
      try {
        await member.roles.add(role, 'Verified via button');
        log('INFO', 'Member verified', { guild: guild.name, user: member.user.tag, role: role.name });
        return interaction.reply({ content: `✅ You've been verified and given the **${role.name}** role.`, flags: [MessageFlags.Ephemeral] });
      } catch (err) {
        log('WARN', 'Failed to assign verify role', { guild: guild.name, error: err.message });
        return interaction.reply({ content: 'Failed to assign role — make sure my role is above the verify role in Server Settings → Roles.', flags: [MessageFlags.Ephemeral] });
      }
    }

    // ── Open to everyone ──────────────────────────────────────────────────────

    if (interaction.customId === 'bot_refresh') {
      await updatePanel(client);
      return interaction.reply({ content: 'Panel refreshed.', flags: [MessageFlags.Ephemeral] });
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

    // ── 🎛️ Mass User Migration Panel Handler (Active Humans Only) ──────────────
    if (interaction.customId === 'bot_admin_drag_init') {
      const { StringSelectMenuBuilder } = require('discord.js');

      if (!interaction.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({ 
          content: '❌ **Access Denied:** You lack the `Move Members` permission required to activate this.', 
          flags: [MessageFlags.Ephemeral] 
        });
      }

      const entry = store.getEntry(guild.id);
      if (!entry || !entry.channelId) {
        return interaction.reply({ 
          content: '❌ **Abuse Prevention:** The application connection state is dormant. Secure the bot inside a voice channel first.', 
          flags: [MessageFlags.Ephemeral] 
        });
      }

      const modVoiceChannel = interaction.member.voice?.channelId;
      if (modVoiceChannel !== entry.channelId) {
        return interaction.reply({ 
          content: `❌ **Access Denied:** You must be present inside the bot's current voice channel (<#${entry.channelId}>) to use this interface!`, 
          flags: [MessageFlags.Ephemeral] 
        });
      }

      const activeVoiceRoom = guild.channels.cache.get(entry.channelId);
      if (!activeVoiceRoom) {
        return interaction.reply({ content: '❌ Could not find the active voice channel.', flags: [MessageFlags.Ephemeral] });
      }

      const activeHumans = activeVoiceRoom.members.filter(m => !m.user.bot);

      if (activeHumans.size === 0) {
        return interaction.reply({
          content: '⚠️ **Operation Aborted:** There are users currently connected in this voice channel to move!',
          flags: [MessageFlags.Ephemeral]
        });
      }

      const dropdownOptions = activeHumans.map(m => ({
        label: m.user.globalName || m.user.username,
        description: `@${m.user.username}`,
        value: m.user.id
      })).slice(0, 25);

      const userSelect = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('drag_select_users')
          .setPlaceholder('Select users to move...')
          .setMinValues(1)
          .setMaxValues(dropdownOptions.length)
          .addOptions(dropdownOptions)
      );

      const channelSelect = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('drag_select_target')
          .setPlaceholder('🔊 Select voice channel...')
          .addChannelTypes(ChannelType.GuildVoice)
      );

      const actionButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('drag_execute_confirm')
          .setLabel('Move Users')
          .setStyle(ButtonStyle.Secondary)
      );

      const menuMessage = await interaction.reply({
        content: `🎛️ **Mass Move**\nDetected **${activeHumans.size}** Users in <#${entry.channelId}>.\n\n1. Select the users.\n2. Choose the voice channel.\n3. Click move to execute.`,
        components: [userSelect, channelSelect, actionButtons],
        flags: [MessageFlags.Ephemeral],
        withResponse: true
      });

      let selectedUserIds = [];
      let targetChannelId = null;

      const collector = menuMessage.resource.message.createMessageComponentCollector({
        time: 180000
      });

      collector.on('collect', async (componentInteraction) => {
        if (componentInteraction.user.id !== interaction.user.id) {
          return componentInteraction.reply({ content: '❌ Access Denied.', flags: [MessageFlags.Ephemeral] });
        }

        if (componentInteraction.customId === 'drag_select_users') {
          selectedUserIds = componentInteraction.values;
          await componentInteraction.deferUpdate();
        }

        if (componentInteraction.customId === 'drag_select_target') {
          targetChannelId = componentInteraction.channels.first()?.id || null;
          await componentInteraction.deferUpdate();
        }

        if (componentInteraction.customId === 'drag_execute_confirm') {
          if (selectedUserIds.length === 0 || !targetChannelId) {
            return componentInteraction.reply({
              content: '⚠️ **Configuration Error:** You must choose the users & voice channel first!',
              flags: [MessageFlags.Ephemeral]
            });
          }

          await componentInteraction.deferReply({ flags: [MessageFlags.Ephemeral] });

          let movedCount = 0;
          let failedCount = 0;

          for (const userId of selectedUserIds) {
            try {
              const memberToMove = await interaction.guild.members.fetch(userId);
              if (!memberToMove.voice.channelId) {
                failedCount++;
                continue;
              }
              await memberToMove.voice.setChannel(targetChannelId);
              movedCount++;
            } catch (err) {
              failedCount++;
            }
          }

          log('INFO', `Move Executed: Moved ${movedCount} users`, {
            user:  interaction.user.tag,
            guild: interaction.guild.name,
          });

          try {
            const { getLogChannel: _glc } = require('../src/guildConfig');
            const { EmbedBuilder: _EB2 } = require('discord.js');
            const btnLogId = _glc(interaction.guild.id, 'commands');
            if (btnLogId) {
              const btnCh = await client.channels.fetch(btnLogId).catch(() => null);
              if (btnCh?.isTextBased()) {
                await btnCh.send({

                  embeds: [
                    new _EB2()
                      .setColor(0x2F3136)
                      .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                      .setTitle('Moved Users Executed')
                      .addFields(
                        { name: 'Moderator', value: `${interaction.member}`, inline: true },
                        { name: 'Destination', value: `<#${targetChannelId}>`, inline: true },
                        { name: 'Results', value: `Moved: \`${movedCount}\` · Skipped/Failed: \`${failedCount}\``, inline: false }
                      )
                      .setTimestamp(),
                  ],
                });
              }
            }
          } catch { /* non-critical */ }

          await componentInteraction.editReply({
            content: `✅ **Move Successful!**\nMoved **${movedCount}** users over to <#${targetChannelId}>.\n*(Skipped ${failedCount} users)*`
          });

          collector.stop();
        }
      });
      return;
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

    // ── Force Leave — role/owner gated ────────────────────────────────────────
    if (interaction.customId === 'bot_forceleave') {
      if (!canControl) {
        return interaction.reply({
          content: botControlRoleId ? `You need the <@&${botControlRoleId}> role.` : 'Only the server owner can use this.',
          flags: [MessageFlags.Ephemeral],
        });
      }
      const conn     = getVoiceConnection(guild.id);
      const hadEntry = store.getEntry(guild.id);
      if (conn) { try { conn.destroy(); } catch (_) {} }
      stopSilencePlayer(guild.id);
      store.clearConnection(guild.id);
      clearLastChannel(guild.id);
      log('VOICE', 'Force leave via panel', { guild: guild.name, by: member.user.tag });
      await updatePanel(client);
      return interaction.reply({
        content: !conn && hadEntry ? 'Cache cleared, Bot state now reset & ready to go.' : '🔴 Force disconnected the from voice channel.',
        flags: [MessageFlags.Ephemeral],
      });
    }
  },
};

