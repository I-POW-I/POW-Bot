/**
 * Role menus: a message with a drop-down where members pick their own roles (pronouns, game pings, colours…).
 *
 * Saved per server as  roleMenus: [{ id, channelId, messageId, title, description, mode: 'multi'|'single', roleIds: [] }]
 * The drop-down's id is `rolemenu:<menu id>`, so it keeps working after a restart. Picking roles gives those, and takes away
 * any other role from the same menu the member no longer has chosen.
 */

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { log } = require('./logger');

const MAX_MENUS = 5, MAX_ROLES = 15;

const menus = (guildId) => (getGuildConfig(guildId).roleMenus || []);
const saveMenus = (guildId, list) => setGuildConfig(guildId, { roleMenus: list });
const newId = () => Math.random().toString(36).slice(2, 8);

/** Roles the bot could not hand out: @everyone, integration-managed ones, and any at or above the bot's own top role. */
function problems(guild, roleIds) {
  const me = guild.members.me, out = [];
  for (const id of roleIds) {
    const r = guild.roles.cache.get(id);
    if (!r) continue;
    if (r.id === guild.id) out.push(`**@everyone** can't be handed out`);
    else if (r.managed) out.push(`**${r.name}** is managed by an integration`);
    else if (me && r.position >= me.roles.highest.position) out.push(`**${r.name}** is above my highest role: move my role higher`);
  }
  return out;
}

function build(guild, menu) {
  const roles = menu.roleIds.map(id => guild.roles.cache.get(id)).filter(Boolean);
  const embed = new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: menu.mode === 'single' ? 'Pick one' : 'Pick any' }).setTitle(menu.title)
    .setDescription([menu.description, roles.map(r => `<@&${r.id}>`).join('  ')].filter(Boolean).join('\n\n'));
  const select = new StringSelectMenuBuilder().setCustomId(`rolemenu:${menu.id}`).setPlaceholder(menu.mode === 'single' ? 'Choose a role…' : 'Choose your roles…')
    .setMinValues(0).setMaxValues(menu.mode === 'single' ? 1 : Math.max(1, roles.length))
    .addOptions(roles.map(r => ({ label: r.name.slice(0, 100), value: r.id })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], allowedMentions: { parse: [] } };
}

async function post(guild, menu, channel) {
  const sent = await channel.send(build(guild, menu));
  return sent.id;
}

/** A member used a role menu. Returns true when the interaction was one. */
async function handle(interaction) {
  if (!interaction.isStringSelectMenu?.() || !interaction.customId?.startsWith('rolemenu:')) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild, member } = interaction;
  const menu = menus(guild.id).find(m => m.id === interaction.customId.slice(9));
  if (!menu) { await interaction.editReply({ content: 'This menu has been removed.' }); return true; }

  const chosen = new Set(interaction.values.filter(v => menu.roleIds.includes(v)));
  const add = [], remove = [], skipped = [];
  for (const id of menu.roleIds) {
    const role = guild.roles.cache.get(id);
    if (!role) continue;
    const has = member.roles.cache.has(id);
    if (chosen.has(id) && !has) (role.editable ? add : skipped).push(role);
    else if (!chosen.has(id) && has) (role.editable ? remove : skipped).push(role);
  }
  try {
    if (add.length) await member.roles.add(add, 'Role menu');
    if (remove.length) await member.roles.remove(remove, 'Role menu');
  } catch (err) {
    log('WARN', 'Role menu could not change roles', { guild: guild.name, err });
    await interaction.editReply({ content: '⚠️ I could not change your roles. Ask an admin to check that my role is above these roles.' });
    return true;
  }
  const names = (l) => l.map(r => `**${r.name}**`).join(', ');
  const parts = [add.length && `Added ${names(add)}.`, remove.length && `Removed ${names(remove)}.`, skipped.length && `⚠️ I can't change ${names(skipped)}: an admin needs to move my role higher.`].filter(Boolean);
  await interaction.editReply({ content: parts.length ? `✅ ${parts.join(' ')}` : 'Nothing changed.' });
  return true;
}

module.exports = { MAX_MENUS, MAX_ROLES, menus, saveMenus, newId, problems, build, post, handle };
