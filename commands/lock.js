const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../src/guildConfig');
const mod = require('../src/moderation');

const P = PermissionFlagsBits;
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** `locks` in the server config remembers what @everyone could do before, so /unlock puts it back exactly. */
function lockedBefore(guildId, channelId) { return (getGuildConfig(guildId).locks || {})[channelId]; }
function remember(guildId, channelId, value) {
  const locks = { ...(getGuildConfig(guildId).locks || {}) };
  if (value === undefined) delete locks[channelId]; else locks[channelId] = value;
  setGuildConfig(guildId, { locks });
}

async function setLocked(interaction, lock) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const reason = (interaction.options.getString('reason') || '').trim();
  const { guild } = interaction;
  if (!guild.members.me.permissions.has(P.ManageChannels)) return interaction.reply({ content: '⚠️ I need the **Manage Channels** permission for that.', flags: [MessageFlags.Ephemeral] });
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const everyone = guild.roles.everyone;
  const current = channel.permissionOverwrites.cache.get(everyone.id);
  const sendNow = current?.allow.has(P.SendMessages) ? true : current?.deny.has(P.SendMessages) ? false : null;
  const threadsNow = current?.allow.has(P.SendMessagesInThreads) ? true : current?.deny.has(P.SendMessagesInThreads) ? false : null;

  try {
    if (lock) {
      if (lockedBefore(guild.id, channel.id) !== undefined) return interaction.editReply({ content: `⚠️ ${channel} is already locked.` });
      remember(guild.id, channel.id, { send: sendNow, threads: threadsNow });
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false, SendMessagesInThreads: false }, { reason: `${mod.tagOf(interaction.user)}: lock${reason ? ` (${reason})` : ''}` });
    } else {
      const before = lockedBefore(guild.id, channel.id);
      if (before === undefined) return interaction.editReply({ content: `⚠️ ${channel} was not locked by me.` });
      await channel.permissionOverwrites.edit(everyone, { SendMessages: before.send, SendMessagesInThreads: before.threads }, { reason: `${mod.tagOf(interaction.user)}: unlock` });
      remember(guild.id, channel.id, undefined);
    }
  } catch (err) {
    return interaction.editReply({ content: `⚠️ Discord refused: ${err.message}` });
  }

  // A short notice in the channel itself, so members know why they can't type
  await channel.send({ embeds: [new EmbedBuilder().setColor(lock ? 0xED4245 : 0x57F287).setDescription(lock
    ? `🔒 This channel is locked.${reason ? `\n${reason}` : ''}` : '🔓 This channel is unlocked.')] }).catch(() => {});
  await mod.sendLog(guild, new EmbedBuilder().setColor(lock ? 0xED4245 : 0x57F287).setTitle(lock ? 'Channel locked' : 'Channel unlocked')
    .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true },
      ...(reason ? [{ name: 'Reason', value: reason.slice(0, 1000), inline: false }] : [])));
  return interaction.editReply({ content: `✅ ${channel} is ${lock ? 'locked' : 'unlocked'}.` });
}

const channelOption = (o) => o.setName('channel').setDescription('Which channel (default: this one)').addChannelTypes(...TEXT);

module.exports = {
  data: new SlashCommandBuilder().setName('lock').setDescription('Stop members from sending messages in a channel.')
    .setDefaultMemberPermissions(P.ManageChannels).setContexts(InteractionContextType.Guild)
    .addChannelOption(channelOption).addStringOption(o => o.setName('reason').setDescription('Shown in the channel and the mod log').setMaxLength(300)),
  execute: (interaction) => setLocked(interaction, true),
  _setLocked: setLocked, _channelOption: channelOption,
};
