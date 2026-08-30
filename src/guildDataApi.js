/*
 * Live guild data — channels, roles, and welcome/leave card previews.
 *
 * This used to be an HTTP server the dashboard called directly. That
 * doesn't work: Discloud's TYPE=bot apps have no public network/subdomain
 * at all (confirmed against docs.discloud.com — only TYPE=site apps get
 * one), so there was never actually anything the dashboard could reach.
 *
 * Instead these are called from src/dashboardSync.js's command processor,
 * which already polls the dashboard's bot_commands queue every 15s for
 * restart/presence commands — channels/roles/preview requests go through
 * the same queue now, with the bot writing its answer into the command's
 * `result` column instead of just marking it completed.
 */

const { ChannelType } = require('discord.js');
const { generateCard } = require('./imageGenerator');
const { normalizeCardConfig } = require('./welcomeConfig');

function getGuildChannels(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot is not in that guild');

  return guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .map((c) => ({ id: c.id, name: c.name, position: c.position }))
    .sort((a, b) => a.position - b.position);
}

function getGuildRoles(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot is not in that guild');

  return guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed) // exclude @everyone and bot-integration roles
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position }))
    .sort((a, b) => b.position - a.position);
}

/**
 * Renders a welcome/leave card preview for a specific real guild member and
 * returns it as a base64 PNG string (small enough — ~40-60KB — to travel
 * through the bot_commands.result jsonb column comfortably).
 */
async function renderWelcomePreview(client, guildId, { discordId, type, cardConfig }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot is not in that guild');
  if (!discordId) throw new Error('discordId is required');

  const member = await guild.members.fetch(discordId);
  const buffer = await generateCard(
    type === 'leave' ? 'leave' : 'welcome',
    { nickname: member.nickname, username: member.user.username },
    member.user.displayAvatarURL({ dynamic: false, size: 512 }),
    guild.memberCount,
    normalizeCardConfig(cardConfig)
  );

  return buffer.toString('base64');
}

module.exports = { getGuildChannels, getGuildRoles, renderWelcomePreview };
