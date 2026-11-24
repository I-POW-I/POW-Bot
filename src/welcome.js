/**
 * Welcome and leave posts, the welcome message to the new member and the roles given on join.
 * Settings and placeholders: src/cards.js. Screens: src/setupWelcome.js.
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getGuildConfig } = require('./guildConfig');
const { selectOne } = require('./database');
const { generateCard } = require('./imageGenerator');
const cards = require('./cards');
const { log } = require('./logger');

const BLUE = 0x5865F2, GREY = 0x747F8D;
const colourOf = (hex, fallback) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? parseInt(hex.slice(1), 16) : fallback);

/**
 * The message for a welcome or leave post: { content, embeds, files, allowedMentions }.
 * `target` is a member (or a user, for the preview), `count` and `joinedMs` describe the moment.
 */
async function buildPost(guild, type, member, { count, joinedMs = null, returning = false, avatarUrl = null, mention = true } = {}) {
  const ctx = cards.contextFor(member, { count, joinedMs, returning });
  const post = cards.compose(guild.id, type, ctx);
  const user = member.user || member;
  const avatar = avatarUrl || user.displayAvatarURL({ extension: 'png', size: 512 });
  const payload = { allowedMentions: mention ? { users: [member.id] } : { parse: [] } };
  if (post.text) payload.content = post.text;

  if (post.card) {
    const buffer = await generateCard(type, ctx.user, avatar, ctx.count, post.image);
    payload.files = [new AttachmentBuilder(buffer, { name: `${type}.png` })];
  }
  if (post.embed) {
    const e = post.embed;
    const embed = new EmbedBuilder().setColor(colourOf(e.colour, type === 'leave' ? GREY : BLUE));
    if (e.title) embed.setTitle(e.title);
    if (e.description) embed.setDescription(e.description);
    if (e.footer) embed.setFooter({ text: e.footer });
    if (post.format === 'both' && post.card) embed.setImage(`attachment://${type}.png`);
    else if (e.avatar) embed.setThumbnail(avatar);
    payload.embeds = [embed];
  }
  return payload;
}

const hasContent = (p) => !!(p.content || p.files?.length || p.embeds?.length);

/** Has this person been in the server before? (From the join and leave history, which is kept 90 days.) */
function isReturning(guildId, userId) {
  try { return !!selectOne("SELECT 1 AS x FROM member_events WHERE guild_id = ? AND user_id = ? AND event = 'leave' LIMIT 1", [String(guildId), String(userId)]); }
  catch { return false; }
}

async function postTo(guild, channelId, payload, label) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !hasContent(payload)) return;
  await channel.send(payload).catch(err => log('WARN', `Failed to send the ${label} post`, { guild: guild.name, err }));
}

async function onJoin(member) {
  const { guild } = member;
  const c = getGuildConfig(guild.id);

  if (c.welcomeChannelId && c.welcomeEnabled !== false) {
    try {
      const payload = await buildPost(guild, 'welcome', member, { returning: isReturning(guild.id, member.id) });
      await postTo(guild, c.welcomeChannelId, payload, 'welcome');
    } catch (err) { log('WARN', 'Failed to build the welcome post', { guild: guild.name, err }); }
  }

  if (member.user.bot) return;

  if (c.welcomeDm) {   // a short message to the new member, in their DMs
    try {
      const ctx = cards.contextFor(member);
      await member.send({ embeds: [new EmbedBuilder().setColor(BLUE).setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
        .setDescription(cards.fill(c.welcomeDmText || cards.DM_DEFAULT, ctx).slice(0, 4000))] });
    } catch { /* their DMs are closed */ }
  }

  await giveJoinRoles(member);
}

/** Roles every new member gets. Skipped when verification is set up, because that decides who gets which role. */
async function giveJoinRoles(member) {
  const c = getGuildConfig(member.guild.id);
  const ids = (c.welcomeRoleIds || []).filter(id => member.guild.roles.cache.has(id));
  if (!ids.length || c.verifyRoleId) return;
  const usable = ids.filter(id => { const r = member.guild.roles.cache.get(id); return r && !r.managed && r.editable; });
  if (!usable.length) return;
  await member.roles.add(usable, 'Welcome: roles for new members').catch(err => log('WARN', 'Could not give the join roles', { guild: member.guild.name, err }));
}

async function onLeave(member) {
  const { guild } = member;
  const c = getGuildConfig(guild.id);
  const channelId = c.leaveChannelId || c.welcomeChannelId;
  if (!channelId || c.leaveEnabled === false) return;
  try {
    const joinedMs = member.joinedTimestamp ? Date.now() - member.joinedTimestamp : null;
    const payload = await buildPost(guild, 'leave', member, { joinedMs, mention: false });
    await postTo(guild, channelId, payload, 'leave');
  } catch (err) { log('WARN', 'Failed to build the leave post', { guild: guild.name, err }); }
}

module.exports = { buildPost, onJoin, onLeave, giveJoinRoles, isReturning, hasContent };
