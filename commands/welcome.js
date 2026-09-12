/**
 * /welcome — configure and test welcome/leave messages.
 *
 * Subcommands:
 *   /welcome setup welcome-channel: leave-channel: — configure channels
 *   /welcome test — preview the welcome card for yourself
 *   /welcome testleave — preview the leave card for yourself
 */

const {
  SlashCommandBuilder, AttachmentBuilder, MessageFlags,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');
const { log }            = require('../src/logger');
const { setGuildConfig, getGuildConfig } = require('../src/guildConfig');
const { generateCard }   = require('../src/imageGenerator');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure and test welcome / leave messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Set the welcome and leave channels')
        .addChannelOption(opt =>
          opt.setName('welcome-channel')
            .setDescription('Channel to post welcome messages in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addChannelOption(opt =>
          opt.setName('leave-channel')
            .setDescription('Channel to post leave messages in (defaults to welcome channel if not set)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt.setName('disable-welcome')
            .setDescription('Turn welcome messages off without clearing the channel')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt.setName('disable-leave')
            .setDescription('Turn leave messages off without clearing the channel')
            .setRequired(false)
        )
    )

    .addSubcommand(sub =>
      sub.setName('test')
        .setDescription('Preview the welcome card — uses your own avatar and name')
    )

    .addSubcommand(sub =>
      sub.setName('testleave')
        .setDescription('Preview the leave card — uses your own avatar and name')
    ),

  async execute(interaction) {
    const { guild, member } = interaction;
    const sub = interaction.options.getSubcommand();

    // ── Setup ─────────────────────────────────────────────────────────────────
    if (sub === 'setup') {
      const welcomeCh     = interaction.options.getChannel('welcome-channel');
      const leaveCh       = interaction.options.getChannel('leave-channel');
      const disableWelcome = interaction.options.getBoolean('disable-welcome');
      const disableLeave   = interaction.options.getBoolean('disable-leave');

      if (!welcomeCh && !leaveCh && disableWelcome === null && disableLeave === null) {
        const config = getGuildConfig(guild.id);
        const wId = config.welcomeChannelId;
        const lId = config.leaveChannelId;
        // Enabled by default if a channel is set — only explicitly false disables it,
        // so existing setups aren't affected by this being a new field.
        const welcomeOn = config.welcomeEnabled !== false && !!wId;
        const leaveOn   = config.leaveEnabled !== false && !!(lId || wId);
        return interaction.reply({
          content: [
            '**Current welcome config:**',
            `Welcome: ${wId ? `<#${wId}>` : '*Not set*'} — ${welcomeOn ? '✅ Enabled' : '⏸️ Disabled'}`,
            `Leave: ${lId ? `<#${lId}>` : (wId ? `<#${wId}> (same as welcome)` : '*Not set*')} — ${leaveOn ? '✅ Enabled' : '⏸️ Disabled'}`,
            '',
            'Use `/welcome setup welcome-channel: leave-channel:` to configure.',
            'Use `disable-welcome:True` or `disable-leave:True` to turn either off without losing the channel.',
            'Use `/welcome test` and `/welcome testleave` to preview.',
          ].join('\n'),
          flags: [MessageFlags.Ephemeral],
        });
      }

      const updates = {};
      if (welcomeCh) updates.welcomeChannelId = welcomeCh.id;
      if (leaveCh)   updates.leaveChannelId   = leaveCh.id;
      if (disableWelcome !== null) updates.welcomeEnabled = !disableWelcome;
      if (disableLeave !== null)   updates.leaveEnabled   = !disableLeave;
      setGuildConfig(guild.id, updates);

      log('INFO', 'Welcome config updated', { guild: guild.name, by: member.user.tag });

      return interaction.reply({
        content: [
          '✅ Welcome config updated:',
          welcomeCh ? `Welcome channel: <#${welcomeCh.id}>` : '',
          leaveCh   ? `Leave channel: <#${leaveCh.id}>` : '',
          disableWelcome === true  ? 'Welcome messages: ⏸️ Disabled' : '',
          disableWelcome === false ? 'Welcome messages: ✅ Enabled' : '',
          disableLeave === true    ? 'Leave messages: ⏸️ Disabled' : '',
          disableLeave === false   ? 'Leave messages: ✅ Enabled' : '',
          '',
          'Run `/welcome test` to preview the card.',
        ].filter(Boolean).join('\n'),
        flags: [MessageFlags.Ephemeral],
      });
    }

    // ── Test / Testleave ──────────────────────────────────────────────────────
    if (sub === 'test' || sub === 'testleave') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const type        = sub === 'test' ? 'welcome' : 'leave';
      const displayName = member.displayName || member.user.username;
      const avatarUrl   = member.user.displayAvatarURL({ dynamic: false, size: 512 });
      const memberCount = guild.memberCount;

      try {
        const buffer     = await generateCard(type, displayName, avatarUrl, memberCount);
        const attachment = new AttachmentBuilder(buffer, { name: `${type}-preview.png` });

        return interaction.editReply({
          content: `**${type === 'welcome' ? 'Welcome' : 'Leave'} card preview** — this is exactly what will be posted:`,
          files:   [attachment],
        });
      } catch (err) {
        log('WARN', 'Welcome card generation failed', { error: err.message });
        return interaction.editReply({
          content: `❌ Card generation failed: ${err.message}\n\nMake sure \`@napi-rs/canvas\` is in \`package.json\` and Discloud has reinstalled packages.`,
        });
      }
    }
  },
};
