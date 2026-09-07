const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { log } = require('../src/logger');
const { getBotControlRoleId } = require('../src/guildConfig');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearcommands')
    .setDescription('Wipe all old/stuck slash commands and re-register the correct ones')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    const { guild, member } = interaction;

    // Same permission source as the panel's Leave / Force Leave buttons
    // (set via /setbotrole) — previously this required Discord's built-in
    // Administrator permission regardless of that setting, which meant two
    // different, disconnected ways to decide "who can control the bot".
    const botControlRoleId = getBotControlRoleId(guild.id);
    const canControl = botControlRoleId
      ? member.roles.cache.has(botControlRoleId)
      : guild.ownerId === member.user.id;

    if (!canControl) {
      return interaction.reply({
        content: botControlRoleId
          ? `❌ You need the <@&${botControlRoleId}> role to use this.`
          : '❌ Only the server owner can use this.',
        flags: [MessageFlags.Ephemeral],
      });
    }

    await interaction.reply({
      content: '🔄 Clearing all commands (global + guild-specific)...',
      flags: [MessageFlags.Ephemeral],
    });

    try {
      const { REST, Routes } = require('discord.js');
      const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

      // Clear global commands
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
      log('INFO', 'Global commands cleared', { by: interaction.user.tag });

      // Clear guild-specific commands for every guild the bot is in
      // (old bots sometimes registered commands per-guild — this catches those)
      const guildResults = [];
      for (const guild of client.guilds.cache.values()) {
        try {
          await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
            { body: [] }
          );
          guildResults.push(`✅ ${guild.name}`);
        } catch {
          guildResults.push(`⚠️ ${guild.name} (skipped)`);
        }
      }

      // Re-register current commands globally
      const commandData = [...client.commands.values()].map(cmd => cmd.data.toJSON());
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commandData });

      log('INFO', `Re-registered ${commandData.length} global command(s)`, { by: interaction.user.tag });

      const names = commandData.map(c => `\`/${c.name}\``).join(', ');

      await interaction.editReply({
        content: [
          `✅ **Done.** Here's what happened:`,
          ``,
          `**Global commands** — wiped and re-registered ${commandData.length} command(s): ${names}`,
          `**Guild commands cleared:** ${guildResults.join(' · ')}`,
          ``,
          `Cleared old/stuck in limbo commands.`,
        ].join('\n'),
      });

    } catch (err) {
      log('ERROR', 'clearcommands failed', { error: err.message });
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
  },
};
