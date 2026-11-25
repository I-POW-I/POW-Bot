/**
 * Everything behind the buttons and menu on the voice panel (see statusUpdater.js for the panel itself).
 *
 *   Join · Move · Leave            choose the channel, and confirm a move or a leave
 *   My card · User lookup          the member card
 *   Busy times · Weekly recap      from the voice history
 *   Leaderboard                    the voice leaderboard
 *   My Server Time Wrapped · Server Wrapped
 *
 * handle() returns true when it dealt with an interaction, so interactionCreate can stop there.
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');

const { log } = require('./logger');
const store = require('./connectionStore');
const { attachDisconnectHandler } = require('./heartbeat');
const { attachSilencePlayer, stopSilencePlayer } = require('./audioPlayer');
const { setLastChannel, clearLastChannel, setStats, getBotControlRoleId } = require('./guildConfig');
const wrapped = require('./wrapped');

const HEALTHY = [VoiceConnectionStatus.Ready, VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting];
const BLUE = 0x5865F2, GREEN = 0x57F287, RED = 0xED4245;
const EPHEMERAL = [MessageFlags.Ephemeral];
const connected = (guildId) => { const c = getVoiceConnection(guildId); return !!c && HEALTHY.includes(c.state.status); };
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const humans = (ch) => ch.members.filter(m => !m.user.bot).size;

// ── Who may do what ───────────────────────────────────────────────────────────

const isAdmin = (member) => member.permissions.has(PermissionFlagsBits.ManageGuild);
function canControl(guild, member) {
  const roleId = getBotControlRoleId(guild.id);
  return roleId ? member.roles.cache.has(roleId) : guild.ownerId === member.user.id;
}
const deniedControl = (guild) => {
  const roleId = getBotControlRoleId(guild.id);
  return roleId ? `You need the <@&${roleId}> role.` : 'Only the server owner can use this.';
};

// ── Voice actions ─────────────────────────────────────────────────────────────

/** Join a channel. Returns { ok, text }. */
function connect(guild, channel, member, client) {
  if (connected(guild.id)) return { ok: false, text: `I am already in **${store.getEntry(guild.id)?.channelName || 'a voice channel'}**. Use Move to change channel.` };
  const stale = getVoiceConnection(guild.id);
  if (stale) { try { stale.destroy(); } catch { /* already gone */ } store.clearConnection(guild.id); stopSilencePlayer(guild.id); }
  try {
    const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
    attachDisconnectHandler(connection, guild.name, channel.name);
    attachSilencePlayer(connection, guild.id);
    store.setConnection(guild.id, { channelId: channel.id, channelName: channel.name, guildName: guild.name });
    setLastChannel(guild.id, channel.id);
    setStats(guild.id, { joinedAt: store.getEntry(guild.id).joinedAt, reconnectCount: 0 });
    require('./presence').refresh(client);
    log('VOICE', 'Joined channel', { guild: guild.name, channel: channel.name, by: member.user.tag });
    return { ok: true, text: `Joined **${channel.name}**.` };
  } catch (err) {
    log('WARN', 'Could not join a voice channel', { guild: guild.name, err });
    return { ok: false, text: 'I could not join. Check I have the **Connect** permission there.' };
  }
}

/** Disconnect without forgetting the server's panel. */
function disconnect(guild, { forget = true } = {}) {
  const conn = getVoiceConnection(guild.id), entry = store.getEntry(guild.id);
  if (conn) { try { conn.destroy(); } catch { /* already gone */ } }
  stopSilencePlayer(guild.id);
  store.clearConnection(guild.id);
  if (forget) clearLastChannel(guild.id);
  return entry;
}

// ── Screens ───────────────────────────────────────────────────────────────────

const screen = (title, description, colour = BLUE) => new EmbedBuilder().setColor(colour).setAuthor({ name: 'Voice' }).setTitle(title).setDescription(description);

/** Voice channels the bot can join, busiest first, as menu options (a menu holds 25). */
function voiceOptions(guild, excludeId = null) {
  const me = guild.members.me;
  return guild.channels.cache
    .filter(c => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && c.id !== excludeId
      && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]))
    .sort((a, b) => humans(b) - humans(a) || a.rawPosition - b.rawPosition)
    .first(25)
    .map(c => ({ label: c.name.slice(0, 100), value: c.id, description: people(humans(c)) }));
}

function joinScreen(guild, member) {
  const options = voiceOptions(guild);
  const here = member.voice?.channel;
  const rows = [];
  if (here?.isVoiceBased() && options.some(o => o.value === here.id)) {
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bot_join_here:${here.id}`).setLabel(`Join ${here.name}`.slice(0, 80)).setStyle(ButtonStyle.Success)));
  }
  if (options.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bot_join_pick').setPlaceholder('Or pick any voice channel').addOptions(options)));
  const text = !options.length ? 'I cannot see any voice channel I can join. Check my **View Channel** and **Connect** permissions.'
    : here ? `You are in **${here.name}**. Join it, or pick another channel.` : 'Pick the voice channel I should join.';
  return { embeds: [screen('Join a voice channel', text)], components: rows };
}

function moveScreen(guild) {
  const entry = store.getEntry(guild.id);
  const options = voiceOptions(guild, entry?.channelId);
  if (!options.length) return { embeds: [screen('Move', 'There is no other voice channel I can move to.', RED)], components: [] };
  return {
    embeds: [screen('Move to another channel', `I am in **${entry?.channelName || 'a voice channel'}**. Pick where I should go. You will be asked to confirm.`)],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bot_move_pick').setPlaceholder('Move to…').addOptions(options))],
  };
}

function moveConfirm(guild, target) {
  const entry = store.getEntry(guild.id), from = guild.channels.cache.get(entry?.channelId);
  return {
    embeds: [screen('Move the bot?', `From **${entry?.channelName || 'the current channel'}**${from ? ` (${people(humans(from))})` : ''}\nTo **${target.name}** (${people(humans(target))})`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bot_move_ok:${target.id}`).setLabel('Yes, move').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bot_move_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
  };
}

function leaveConfirm(guild) {
  const entry = store.getEntry(guild.id), ch = guild.channels.cache.get(entry?.channelId);
  return {
    embeds: [screen('Disconnect the bot?', `I will leave **${entry?.channelName || 'the voice channel'}**${ch ? `, where ${people(humans(ch))} ${humans(ch) === 1 ? 'is' : 'are'} now` : ''}. I will stay out until someone uses Join again.`, RED)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bot_leave_ok').setLabel('Yes, disconnect').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('bot_leave_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
  };
}

const done = (title, text, colour = GREEN) => ({ embeds: [screen(title, text, colour)], components: [], files: [] });
const say = (interaction, content) => interaction.reply({ content, flags: EPHEMERAL });

// ── Handlers ──────────────────────────────────────────────────────────────────

async function refreshPanel(client) { try { await require('./statusUpdater').updatePanel(client); } catch { /* the next update catches up */ } }

async function openWrapped(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  return interaction.editReply(await wrapped.memberWrapped(interaction.guild, interaction.member));
}

const lookupPrompt = (interaction) => interaction.reply({
  embeds: [screen('Member lookup', 'Pick a member to see their card.')],
  components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('bot_lookup_user').setPlaceholder('Select a member…'))],
  flags: EPHEMERAL,
});

async function button(interaction, client) {
  const { guild, member, customId: id } = interaction;
  const [name, arg] = id.split(':');

  switch (name) {
    case 'bot_join': {
      if (!isAdmin(member)) return say(interaction, 'You need **Manage Server** to use this.');
      if (connected(guild.id)) return interaction.reply({ ...moveScreen(guild), flags: EPHEMERAL });
      return interaction.reply({ ...joinScreen(guild, member), flags: EPHEMERAL });
    }
    case 'bot_join_here': {
      if (!isAdmin(member)) return say(interaction, 'You need **Manage Server** to use this.');
      const channel = guild.channels.cache.get(arg);
      if (!channel?.isVoiceBased()) return interaction.update(done('Join', 'That channel no longer exists.', RED));
      const r = connect(guild, channel, member, client);
      await interaction.update(done(r.ok ? 'Joined' : 'Could not join', r.text, r.ok ? GREEN : RED));
      return refreshPanel(client);
    }
    case 'bot_move': {
      if (!isAdmin(member) && !canControl(guild, member)) return say(interaction, 'You need **Manage Server** to use this.');
      if (!connected(guild.id)) return say(interaction, 'I am not in a voice channel. Use **Join** first.');
      return interaction.reply({ ...moveScreen(guild), flags: EPHEMERAL });
    }
    case 'bot_move_ok': {
      if (!isAdmin(member) && !canControl(guild, member)) return interaction.update(done('Move', 'You need **Manage Server** to use this.', RED));
      const target = guild.channels.cache.get(arg);
      if (!target?.isVoiceBased()) return interaction.update(done('Move', 'That channel no longer exists.', RED));
      disconnect(guild, { forget: false });
      const r = connect(guild, target, member, client);
      await interaction.update(done(r.ok ? 'Moved' : 'Could not move', r.ok ? `Now in **${target.name}**.` : r.text, r.ok ? GREEN : RED));
      return refreshPanel(client);
    }
    case 'bot_move_no':
    case 'bot_leave_no':
      return interaction.update(done('Cancelled', 'Nothing was changed.', BLUE));
    case 'bot_leave': {
      if (!canControl(guild, member)) return say(interaction, deniedControl(guild));
      if (!connected(guild.id) && !store.getEntry(guild.id)) return say(interaction, 'I am not connected.');
      return interaction.reply({ ...leaveConfirm(guild), flags: EPHEMERAL });
    }
    case 'bot_leave_ok': {
      if (!canControl(guild, member)) return interaction.update(done('Disconnect', deniedControl(guild), RED));
      const entry = disconnect(guild);
      require('./presence').refresh(client);
      log('VOICE', 'Left via panel', { guild: guild.name, by: member.user.tag });
      await interaction.update(done('Disconnected', `Left **${entry?.channelName || 'the voice channel'}**.`));
      return refreshPanel(client);
    }
    case 'bot_myinfo':
      return interaction.reply({ embeds: [require('./statusUpdater').buildMemberEmbed(member, guild, 'My card')], flags: EPHEMERAL });
    case 'bot_lookup':
      return lookupPrompt(interaction);
    case 'bot_leaderboard':
    case 'bot_info':   // the old name of this button, so panels posted before the update keep working
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await require('./leaderboard').view(guild, 'all', interaction.user.id));
    case 'bot_busy':
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await wrapped.busyTimes(guild));
    case 'bot_recap':
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await wrapped.weeklyRecap(guild, interaction.user.id));
    case 'bot_swrapped':
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await wrapped.serverWrapped(guild));
    case 'bot_mywrapped':
      return openWrapped(interaction);
    default:
      return null;
  }
}

async function menu(interaction, client) {
  const { guild, member, customId: id } = interaction;
  if (id === 'bot_more') {
    const pick = interaction.values[0];
    if (pick === 'mywrapped') return openWrapped(interaction);
    if (pick === 'lookup') return lookupPrompt(interaction);
    if (pick === 'busy' || pick === 'recap' || pick === 'swrapped') {
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(pick === 'busy' ? await wrapped.busyTimes(guild) : pick === 'recap' ? await wrapped.weeklyRecap(guild, interaction.user.id) : await wrapped.serverWrapped(guild));
    }
    return say(interaction, 'That option is not available.');
  }
  if (id === 'bot_join_pick' || id === 'bot_join_channel') {
    if (!isAdmin(member)) return interaction.update(done('Join', 'You need **Manage Server** to use this.', RED));
    const channel = guild.channels.cache.get(id === 'bot_join_pick' ? interaction.values[0] : interaction.channels?.first()?.id);
    if (!channel?.isVoiceBased()) return interaction.update(done('Join', 'That is not a voice channel.', RED));
    const r = connect(guild, channel, member, client);
    await interaction.update(done(r.ok ? 'Joined' : 'Could not join', r.text, r.ok ? GREEN : RED));
    return refreshPanel(client);
  }
  if (id === 'bot_move_pick') {
    if (!isAdmin(member) && !canControl(guild, member)) return interaction.update(done('Move', 'You need **Manage Server** to use this.', RED));
    const target = guild.channels.cache.get(interaction.values[0]);
    if (!target?.isVoiceBased()) return interaction.update(done('Move', 'That channel no longer exists.', RED));
    return interaction.update(moveConfirm(guild, target));
  }
  return null;
}

async function userPick(interaction) {
  const { guild } = interaction;
  const user = interaction.users.first();
  const target = await guild.members.fetch(user.id).catch(() => null);
  if (!target) return say(interaction, 'I could not find that member.');
  return interaction.reply({ embeds: [require('./statusUpdater').buildMemberEmbed(target, guild, 'Member')], flags: EPHEMERAL });
}

const IDS = /^bot_(join|join_here|join_pick|join_channel|move|move_pick|move_ok|move_no|leave|leave_ok|leave_no|myinfo|lookup|lookup_user|leaderboard|info|busy|recap|swrapped|mywrapped|more)(:|$)/;

/** True when the interaction belonged to the voice panel and has been answered. */
async function handle(interaction, client) {
  const id = interaction.customId;
  if (!id || !interaction.guild || !IDS.test(id)) return false;
  try {
    if (interaction.isButton()) await button(interaction, client);
    else if (interaction.isUserSelectMenu() && id === 'bot_lookup_user') await userPick(interaction);
    else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) await menu(interaction, client);
    else return false;
  } catch (err) {
    if ([10062, 40060].includes(err?.code)) throw err;
    log('ERROR', `Voice panel: ${id}`, { guild: interaction.guild.name, user: interaction.user.tag, err });
    const content = 'Something went wrong with that. Try again in a moment.';
    try { if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: EPHEMERAL }); else await interaction.reply({ content, flags: EPHEMERAL }); } catch { /* expired */ }
  }
  return true;
}

module.exports = { handle, connect, disconnect, voiceOptions, joinScreen, moveScreen, moveConfirm, leaveConfirm, canControl };
