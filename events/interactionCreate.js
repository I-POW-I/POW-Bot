const { Events, MessageFlags } = require('discord.js');
const { log }                     = require('../src/logger');
const diagnostics                = require('../src/diagnostics');
const globalConfig               = require('../src/globalConfig');
const { isBotAdmin }             = require('../src/permissions');

// Modules that own their own buttons / menus / modals. Each returns true when it handled the interaction.
const DELEGATES = [
  () => require('../src/ownerMonitor').handleComponent,   // alert-DM buttons + restart confirmation
  () => require('../commands/owner').handleComponent,     // /owner panels, announcements, bans
  () => require('../src/setup').handleInteraction,        // /setup screens
  () => require('../src/verification').handleInteraction, // verify button, human check, "Why?"
  () => require('../commands/help').handleComponent,      // /help category menu
  () => require('../commands/privacy').handleComponent,   // /privacy delete buttons
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
      // the bot owner's own /owner screens are never written to a server's log
      const cmdLogId = interaction.guild && interaction.commandName !== 'owner' ? getLogChannel(interaction.guild.id, 'commands') : null;
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
                    { name: 'Used by', value: `${interaction.member || interaction.user} — ${interaction.user.tag}`, inline: true },
                    { name: 'Channel', value: interaction.channel ? `<#${interaction.channel.id}>` : '—',            inline: true },
                    ...(cmdArgs ? [{ name: 'Options', value: cmdArgs, inline: false }] : []),
                  )
                  ,
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


    
    // ── Voice panel menus (join and move pickers, More, member lookup) ─────────
    if (!interaction.isButton() && await require('../src/voicePanel').handle(interaction, client)) return;

    // ── Changelog: pick an older update ────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'cl:pick') {
      return interaction.update(require('../src/announcements').changelogView(Number(interaction.values[0])));
    }

    // ── Leaderboard period select ──────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'lb:period') {
      await interaction.deferUpdate();
      return interaction.editReply(await require('../src/leaderboard').view(interaction.guild, interaction.values[0], interaction.user.id));
    }

    if (!interaction.isButton()) return;

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
          const btnLogId = String(interaction.customId).startsWith('owner:') ? null : _glc(interaction.guild.id, 'commands');
          if (btnLogId) {
            const btnCh = await client.channels.fetch(btnLogId).catch(() => null);
            if (btnCh?.isTextBased()) {
              const BUTTON_LABELS = {
                bot_join: 'Join', bot_leave: 'Leave', bot_move: 'Move',
                bot_myinfo: 'My card', bot_lookup: 'User lookup',
                bot_busy: 'Busy times', bot_recap: 'Weekly recap', bot_swrapped: 'Server Wrapped', bot_mywrapped: 'My Server Time Wrapped',
                bot_leaderboard: 'Leaderboard', bot_info: 'Leaderboard',
              };
              const label = BUTTON_LABELS[interaction.customId] || interaction.customId;
              await btnCh.send({
                embeds: [
                  new _EB2()
                    .setColor(0x9C59D1)
                    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                    .setTitle(`Button: ${label}`)
                    .addFields(
                      { name: 'Used by', value: `${interaction.member || interaction.user} — ${interaction.user.tag}`, inline: true },
                      { name: 'Channel', value: interaction.channel ? `<#${interaction.channel.id}>` : '—',            inline: true },
                    )
                    ,
                ],
              });
            }
          }
        } catch { /* non-critical */ }
      }
    }
    // ── Voice panel buttons (join, move, leave, cards, busy times, recap, Wrapped) ──
    if (await require('../src/voicePanel').handle(interaction, client)) return;
}

// ── Safety net, global gates, and the exported handler ───────────────────────

const EXPIRED_CODES = new Set([10062, 40060]);   // Unknown interaction · already acknowledged

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
    else await interaction.reply({ content: `${message}`, flags: [MessageFlags.Ephemeral] });
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
        // Discord drops an interaction that isn't answered within 3 seconds (10062), and refuses a second answer (40060).
        // Both are normal when the bot is briefly slow or a button is clicked twice, so they are logged quietly.
        if (EXPIRED_CODES.has(err?.code)) {
          log('WARN', `${label} could not be answered in time`, { guild: interaction.guild?.name || 'DM', user: interaction.user?.tag, code: err.code });
          return;
        }
        log('ERROR', `Unhandled error in ${label}`, { guild: interaction.guild?.name || 'DM', user: interaction.user?.tag, err });
        await replyFailure(interaction);
      }
    });
  },
};
