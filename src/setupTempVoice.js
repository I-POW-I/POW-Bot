/**
 * /setup > Join to create: pick a hub voice channel; whoever joins it gets a voice room of their own, deleted when empty.
 *
 * customIds: setup:tempvoice[:hub|make|name|limit|off]
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const kit = require('./setupKit');
const tv = require('./tempVoice');
const { audit } = require('./diagnostics');

const { BLUE, chan, noteBad, noteGood, backButton, channelSelect, respond } = kit;
const PAGES = ['tempvoice'];
const owns = (page) => PAGES.includes(page);
const row = (...c) => new ActionRowBuilder().addComponents(...c);

function viewTempVoice(guild, user, note) {
  const s = tv.settings(guild.id), rooms = Object.keys(s.rooms).length;
  const lacking = tv.NEEDS.filter(p => !guild.members.me.permissions.has(p));
  const lines = [note,
    'Members who join the **hub** channel get a voice room of their own named after them, and are moved into it. The room is deleted when everyone has left. They can rename it and set its limit themselves.',
    '',
    `**Hub channel:** ${s.hubId ? chan(s.hubId) : '*not set*'}`,
    `**Room name:** ${s.name.replace('{user}', 'Sam').replace('{n}', '1')}`,
    `**User limit:** ${s.limit ? `${s.limit} people` : 'no limit'}`,
    `**Rooms open now:** ${rooms}`,
    lacking.length ? `\n⚠️ I am missing **${lacking.join(', ')}**. Give them to my role so rooms can be made.` : null].filter(v => v != null).join('\n');
  return { embeds: [new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Setup · Join to create' }).setTitle('Join to create').setDescription(lines)], components: [
    channelSelect('setup:tempvoice:hub', 'Choose the hub voice channel', s.hubId, [ChannelType.GuildVoice]),
    row(new StringSelectMenuBuilder().setCustomId('setup:tempvoice:name').setPlaceholder('Room name').addOptions(tv.NAMES.map(([v, label]) => ({ label, value: v, default: v === s.name })))),
    row(new StringSelectMenuBuilder().setCustomId('setup:tempvoice:limit').setPlaceholder('User limit').addOptions(tv.LIMITS.map(n => ({ label: n ? `${n} people` : 'No limit', value: String(n), default: n === s.limit })))),
    row(new ButtonBuilder().setCustomId('setup:tempvoice:make').setLabel('Create a hub channel for me').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('setup:tempvoice:off').setLabel('Turn off').setStyle(ButtonStyle.Danger).setDisabled(!s.hubId), backButton()),
  ] };
}
const VIEWS = { tempvoice: (guild, user, note) => viewTempVoice(guild, user, note) };

async function handle(interaction, { guild, by, action }) {
  const show = (note) => respond(interaction, viewTempVoice(guild, by, note));
  const done = (a, d) => audit({ action: `Setup: ${a}`, actor: by, guild, details: d });
  const s = tv.settings(guild.id);
  if (!action) return show();
  if (action === 'hub') {
    const channel = interaction.channels.first();
    if (!channel) return show(noteBad('I could not find that channel.'));
    s.hubId = channel.id; tv.save(guild.id, s); done('Join to create hub', `→ ${channel.name}`);
    return show(noteGood(`${channel} is the hub. Anyone who joins it gets their own room.`));
  }
  if (action === 'make') {
    if (!guild.members.me.permissions.has('ManageChannels')) return show(noteBad('I need **Manage Channels** to create it.'));
    await interaction.deferUpdate();
    try {
      const channel = await guild.channels.create({ name: '➕ Join to create', type: ChannelType.GuildVoice, reason: `Join to create hub: ${by.tag}` });
      s.hubId = channel.id; tv.save(guild.id, s); done('Join to create hub created', channel.name);
      return show(noteGood(`Created ${channel}. Move it wherever you like.`));
    } catch { return show(noteBad('Discord refused to create the channel.')); }
  }
  if (action === 'name') { const v = interaction.values[0]; if (tv.NAMES.some(n => n[0] === v)) { s.name = v; tv.save(guild.id, s); done('Join to create room name', v); } return show(noteGood('Room name saved. It applies to new rooms.')); }
  if (action === 'limit') { s.limit = Number(interaction.values[0]) || 0; tv.save(guild.id, s); done('Join to create limit', String(s.limit)); return show(noteGood('Limit saved. It applies to new rooms.')); }
  if (action === 'off') { s.hubId = null; tv.save(guild.id, s); done('Join to create off'); return show(noteGood('Turned off. Rooms already open are deleted when they empty.')); }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
