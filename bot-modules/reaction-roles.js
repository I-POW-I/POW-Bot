const { supabase } = require('./supabase-client');
const { EmbedBuilder } = require('discord.js');

// Cache: guildId -> { groups, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60_000;

async function loadGuild(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.groups;
  const { data, error } = await supabase
    .from('reaction_role_groups')
    .select('*, reaction_roles(*)')
    .eq('guild_id', guildId)
    .eq('enabled', true);
  if (error) {
    console.error('[reaction-roles] fetch error:', error.message);
    return cached?.groups ?? [];
  }
  const groups = data ?? [];
  cache.set(guildId, { groups, fetchedAt: Date.now() });
  return groups;
}

function invalidateCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

function emojiMatches(reaction, bindingEmoji) {
  const r = reaction.emoji;
  if (r.id) {
    // Custom emoji: compare by id if stored, else by name
    return bindingEmoji === r.id || bindingEmoji === r.identifier || bindingEmoji === r.name;
  }
  // Unicode emoji
  return bindingEmoji === r.name;
}

async function findBinding(reaction) {
  if (!reaction.message.guild) return null;
  const groups = await loadGuild(reaction.message.guild.id);
  const msgId = reaction.message.id;
  for (const g of groups) {
    if (g.message_id && g.message_id !== msgId) continue;
    const binding = (g.reaction_roles ?? []).find((r) => emojiMatches(reaction, r.emoji));
    if (binding) return { group: g, binding };
  }
  return null;
}

async function handleAdd(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }
  const guild = reaction.message.guild;
  if (!guild) return;

  const found = await findBinding(reaction);
  if (!found) return;
  const { group, binding } = found;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  // Unique/single mode: remove other roles in the group first
  if (group.mode === 'single') {
    for (const r of group.reaction_roles ?? []) {
      if (r.id === binding.id) continue;
      const role = guild.roles.cache.get(r.role_id);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, 'Reaction role: switched to single mode').catch(() => {});
      }
    }
  }

  const role = guild.roles.cache.get(binding.role_id);
  if (!role) return;
  if (member.roles.cache.has(role.id)) return; // verify mode already has it

  try {
    await member.roles.add(role, `Reaction role: ${group.title}`);
  } catch (e) {
    console.error('[reaction-roles] add role failed:', e.message);
  }
}

async function handleRemove(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }
  const guild = reaction.message.guild;
  if (!guild) return;

  const found = await findBinding(reaction);
  if (!found) return;
  const { group, binding } = found;

  // Verify mode: role is added once and locked; do not remove on un-react
  if (group.mode === 'verify') return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  const role = guild.roles.cache.get(binding.role_id);
  if (!role) return;

  try {
    await member.roles.remove(role, `Reaction role removed: ${group.title}`);
  } catch (e) {
    console.error('[reaction-roles] remove role failed:', e.message);
  }
}

// Optional helper: post the panel message for a group (called on demand or on create)
async function postPanel(group, client) {
  const guild = client.guilds.cache.get(group.guild_id);
  if (!guild) return null;
  const channel = guild.channels.cache.get(group.channel_id);
  if (!channel || !channel.isTextBased?.()) return null;

  const rows = (group.reaction_roles ?? []).sort((a, b) => a.position - b.position);
  const fields = rows.map((r) => ({
    name: `${r.emoji} ${r.label || 'Role'}`,
    value: r.description || `<@&${r.role_id}>`,
  }));

  const embed = new EmbedBuilder()
    .setTitle(group.title)
    .setColor(0x3498db)
    .setDescription(group.description || 'React below to assign yourself a role.')
    .addFields(fields.length ? fields : { name: 'No roles', value: 'Add roles from the dashboard.' })
    .setFooter({ text: 'Reaction Roles' });

  const sent = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!sent) return null;

  // React with each emoji so members can click
  for (const r of rows) {
    try {
      const emoji = r.emoji.includes(':') ? r.emoji : r.emoji; // unicode as-is; custom parse handled by discord
      await sent.react(emoji).catch(() => {});
    } catch {}
  }

  // Persist the message id so re-reactions find it
  await supabase
    .from('reaction_role_groups')
    .update({ message_id: sent.id })
    .eq('id', group.id)
    .then(() => invalidateCache(group.guild_id));

  return sent.id;
}

module.exports = { handleAdd, handleRemove, postPanel, invalidateCache, loadGuild };
