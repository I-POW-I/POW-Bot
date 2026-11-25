/**
 * /setup > Role menus: build a message where members choose their own roles.
 *
 * A menu is made in a few steps (title, then the roles, the channel and one-or-many), posted, and listed here so it can be
 * reposted or removed. The draft lives in memory only until it is posted.
 *
 * customIds: setup:roles[:new|newmodal|dr|dc|dm|dpost|dcancel|open|repost|delete|delete_yes[:<menu id>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const kit = require('./setupKit');
const menus = require('./roleMenus');
const { audit } = require('./diagnostics');
const { log } = require('./logger');

const { BLUE, chan, noteBad, noteGood, backButton, channelSelect, missingIn, respond } = kit;
const PAGES = ['roles'];
const owns = (page) => PAGES.includes(page);

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const frame = (title, description) => new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Setup · Role menus' }).setTitle(title).setDescription(description);

const drafts = new Map();                       // "guild:user" → draft
const key = (guild, user) => `${guild.id}:${user.id}`;

function viewRoles(guild, user, note) {
  const list = menus.menus(guild.id);
  const lines = [note,
    'A role menu is a message with a drop-down. Members choose their own roles from it: pronouns, game pings, colours, anything.',
    '',
    list.length ? list.map(m => `**${m.title}** in ${chan(m.channelId)}: ${m.roleIds.length} roles, ${m.mode === 'single' ? 'pick one' : 'pick any'}`).join('\n') : '*No menus yet.*',
    '', '*My role has to be above the roles a menu hands out.*'].filter(v => v != null).join('\n');
  const components = [];
  if (list.length) components.push(row(new StringSelectMenuBuilder().setCustomId('setup:roles:open').setPlaceholder('Open a menu…').addOptions(list.map(m => ({ label: m.title.slice(0, 100), value: m.id, description: `${m.roleIds.length} roles` })))));
  components.push(row(btn('setup:roles:new', 'New menu', ButtonStyle.Primary, list.length >= menus.MAX_MENUS), backButton()));
  return { embeds: [frame('Role menus', lines)], components };
}
const VIEWS = { roles: (guild, user, note) => viewRoles(guild, user, note) };

function viewDraft(guild, user, note) {
  const d = drafts.get(key(guild, user));
  if (!d) return viewRoles(guild, user, noteBad('That draft expired. Start again.'));
  const lines = [note, `**Title:** ${d.title}`, d.description ? `**Text:** ${d.description}` : null,
    `**Roles:** ${d.roleIds.length ? d.roleIds.map(id => `<@&${id}>`).join(' ') : '*choose below*'}`,
    `**Channel:** ${chan(d.channelId)}`, `**Members can:** ${d.mode === 'single' ? 'pick one role' : 'pick any number of roles'}`].filter(Boolean).join('\n');
  const rs = new RoleSelectMenuBuilder().setCustomId('setup:roles:dr').setPlaceholder('Roles members can pick (up to 15)').setMinValues(1).setMaxValues(menus.MAX_ROLES);
  if (d.roleIds.length) rs.setDefaultRoles(d.roleIds);
  return { embeds: [frame('New role menu', lines)], components: [
    row(rs), channelSelect('setup:roles:dc', 'Channel to post it in', d.channelId),
    row(btn('setup:roles:dm', d.mode === 'single' ? 'Pick one' : 'Pick any', ButtonStyle.Secondary), btn('setup:roles:dpost', 'Post menu', ButtonStyle.Success, !d.roleIds.length || !d.channelId), btn('setup:roles:dcancel', 'Cancel')),
  ] };
}

function viewMenu(guild, menu, note) {
  const lines = [note, `**Channel:** ${chan(menu.channelId)}`, `**Roles:** ${menu.roleIds.map(id => `<@&${id}>`).join(' ')}`, `**Members can:** ${menu.mode === 'single' ? 'pick one role' : 'pick any number of roles'}`,
    menu.messageId ? `[Open the message](https://discord.com/channels/${guild.id}/${menu.channelId}/${menu.messageId})` : null].filter(Boolean).join('\n');
  return { embeds: [frame(menu.title, lines)], components: [row(btn(`setup:roles:repost:${menu.id}`, 'Post again', ButtonStyle.Primary), btn(`setup:roles:delete:${menu.id}`, 'Remove menu', ButtonStyle.Danger), backButton('roles'))] };
}

async function handle(interaction, { guild, by, action, arg }) {
  const k = key(guild, by), done = (a, d) => audit({ action: `Setup: ${a}`, actor: by, guild, details: d });
  const show = (note) => respond(interaction, viewRoles(guild, by, note));
  const draft = () => drafts.get(k);
  if (!action) return show();

  if (action === 'new') {
    return interaction.showModal(new ModalBuilder().setCustomId('setup:roles:newmodal').setTitle('New role menu').addComponents(
      row(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true).setPlaceholder('Pick your roles')),
      row(new TextInputBuilder().setCustomId('text').setLabel('Text under the title (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false))));
  }
  if (action === 'newmodal') {
    drafts.set(k, { title: interaction.fields.getTextInputValue('title').trim(), description: interaction.fields.getTextInputValue('text').trim(), roleIds: [], channelId: null, mode: 'multi' });
    return respond(interaction, viewDraft(guild, by));
  }
  if (action === 'dr' && draft()) { draft().roleIds = [...interaction.values]; const bad = menus.problems(guild, draft().roleIds); return respond(interaction, viewDraft(guild, by, bad.length ? noteBad(bad.join('. ')) : null)); }
  if (action === 'dc' && draft()) { draft().channelId = interaction.channels.first()?.id || null; return respond(interaction, viewDraft(guild, by)); }
  if (action === 'dm' && draft()) { draft().mode = draft().mode === 'single' ? 'multi' : 'single'; return respond(interaction, viewDraft(guild, by)); }
  if (action === 'dcancel') { drafts.delete(k); return show(); }
  if (action === 'dpost') {
    const d = draft(); if (!d) return show(noteBad('That draft expired. Start again.'));
    const channel = guild.channels.cache.get(d.channelId);
    if (!channel) return respond(interaction, viewDraft(guild, by, noteBad('Choose a channel.')));
    const missing = missingIn(channel, guild);
    if (missing.length) return respond(interaction, viewDraft(guild, by, noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`)));
    const bad = menus.problems(guild, d.roleIds);
    if (bad.length) return respond(interaction, viewDraft(guild, by, noteBad(bad.join('. '))));
    const menu = { id: menus.newId(), channelId: channel.id, messageId: null, title: d.title, description: d.description, mode: d.mode, roleIds: d.roleIds };
    try { menu.messageId = await menus.post(guild, menu, channel); }
    catch (err) { log('WARN', 'Could not post a role menu', { guild: guild.name, err }); return respond(interaction, viewDraft(guild, by, noteBad('Discord refused the message.'))); }
    menus.saveMenus(guild.id, [...menus.menus(guild.id), menu]); drafts.delete(k);
    done('Role menu posted', `${menu.title} in #${channel.name}`);
    return show(noteGood(`Posted **${menu.title}** in ${channel}.`));
  }
  const menu = menus.menus(guild.id).find(m => m.id === (arg || interaction.values?.[0]));
  if (action === 'open') return menu ? respond(interaction, viewMenu(guild, menu)) : show(noteBad('That menu no longer exists.'));
  if (action === 'repost') {
    if (!menu) return show(noteBad('That menu no longer exists.'));
    const channel = guild.channels.cache.get(menu.channelId);
    if (!channel) return respond(interaction, viewMenu(guild, menu, noteBad('The channel was deleted.')));
    try {
      const old = menu.messageId && await channel.messages.fetch(menu.messageId).catch(() => null);
      menu.messageId = await menus.post(guild, menu, channel); if (old) await old.delete().catch(() => {});
    } catch (err) { log('WARN', 'Could not repost a role menu', { guild: guild.name, err }); return respond(interaction, viewMenu(guild, menu, noteBad('Discord refused the message.'))); }
    menus.saveMenus(guild.id, menus.menus(guild.id).map(m => m.id === menu.id ? menu : m));
    return respond(interaction, viewMenu(guild, menu, noteGood('Posted again.')));
  }
  if (action === 'delete') return menu ? respond(interaction, { embeds: [frame(`Remove ${menu.title}?`, 'The message is deleted and members can no longer use the menu. Roles they already have stay.')], components: [row(btn(`setup:roles:delete_yes:${menu.id}`, 'Remove it', ButtonStyle.Danger), btn(`setup:roles:open:${menu.id}`, 'Cancel'))] }) : show();
  if (action === 'delete_yes') {
    if (menu) {
      const msg = await guild.channels.cache.get(menu.channelId)?.messages.fetch(menu.messageId).catch(() => null); await msg?.delete().catch(() => {});
      menus.saveMenus(guild.id, menus.menus(guild.id).filter(m => m.id !== menu.id)); done('Role menu removed', menu.title);
    }
    return show(noteGood('Menu removed.'));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
