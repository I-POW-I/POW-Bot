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
const { getWelcomeConfig, setWelcomeConfig } = require('../src/welcomeConfig');
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
      const welcomeCh = interaction.options.getChannel('welcome-channel');
      const leaveCh   = interaction.options.getChannel('leave-channel');

      if (!welcomeCh && !leaveCh) {
        const config = await getWelcomeConfig(guild.id);
        const wId = config.welcomeChannelId;
        const lId = config.leaveChannelId;
        return interaction.reply({
          content: [
            '**Current welcome config:**',
            `Welcome channel: ${wId ? `<#${wId}>` : '*Not set*'}`,
            `Leave channel: ${lId ? `<#${lId}>` : (wId ? `<#${wId}> (same as welcome)` : '*Not set*')}`,
            '',
            'Use `/welcome setup welcome-channel: leave-channel:` to configure.',
            'Use `/welcome test` and `/welcome testleave` to preview.',
            '',
            'Card look (name shown, color, layout) can be customised from the dashboard.',
          ].join('\n'),
          flags: [MessageFlags.Ephemeral],
        });
      }

      const updates = {};
      if (welcomeCh) updates.welcomeChannelId = welcomeCh.id;
      if (leaveCh)   updates.leaveChannelId   = leaveCh.id;
      await setWelcomeConfig(guild.id, updates);

      log('INFO', 'Welcome config updated', { guild: guild.name, by: member.user.tag });

      return interaction.reply({
        content: [
          '✅ Welcome config updated:',
          welcomeCh ? `Welcome channel: <#${welcomeCh.id}>` : '',
          leaveCh   ? `Leave channel: <#${leaveCh.id}>` : '',
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
      const avatarUrl   = member.user.displayAvatarURL({ dynamic: false, size: 512 });
      const memberCount = guild.memberCount;
      const welcomeConfig = await getWelcomeConfig(guild.id);

      try {
        const buffer     = await generateCard(
          type,
          { nickname: member.nickname, username: member.user.username },
          avatarUrl,
          memberCount,
          welcomeConfig.cardConfig
        );
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
