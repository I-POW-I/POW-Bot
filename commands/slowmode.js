const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const mod = require('../src/moderation');
const { duration } = require('../src/duration');

module.exports = {
  data: new SlashCommandBuilder().setName('slowmode').setDescription('Limit how often each member can send a message in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).setContexts(InteractionContextType.Guild)
    .addStringOption(o => o.setName('length').setDescription('Time between messages, like 10s, 5m or 1h. Use off to turn it off.').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Which channel (default: this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const text = interaction.options.getString('length').trim().toLowerCase();
    const ms = ['off', '0', 'none'].includes(text) ? 0 : mod.parseDuration(text);
    if (ms === null || ms > 6 * 3_600_000) return interaction.reply({ content: '⚠️ Use a time like `10s`, `5m` or `1h` (up to 6 hours), or `off`.', flags: [MessageFlags.Ephemeral] });
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return interaction.reply({ content: '⚠️ I need the **Manage Channels** permission for that.', flags: [MessageFlags.Ephemeral] });

    try { await channel.setRateLimitPerUser(Math.round(ms / 1000), `${mod.tagOf(interaction.user)}: slowmode`); }
    catch (err) { return interaction.reply({ content: `⚠️ Discord refused: ${err.message}`, flags: [MessageFlags.Ephemeral] }); }

    await mod.sendLog(interaction.guild, new EmbedBuilder().setColor(0x5865F2).setTitle(ms ? 'Slowmode on' : 'Slowmode off')
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true },
        ...(ms ? [{ name: 'Every', value: duration(ms, { seconds: true }), inline: true }] : [])));
    return interaction.reply({ content: ms ? `✅ Slowmode in ${channel}: one message every ${duration(ms, { seconds: true })}.` : `✅ Slowmode in ${channel} is off.`, flags: [MessageFlags.Ephemeral] });
  },
};
