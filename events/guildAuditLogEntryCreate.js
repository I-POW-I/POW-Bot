const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }           = require('../src/logger');

const { groupOf, enabled, serverRoute } = require('../src/logs');
const fmt = require('../src/auditFormat');

const LABELS = {
  [AuditLogEvent.ChannelCreate]:    { title: 'Channel created',          colour: 0x57F287 },
  [AuditLogEvent.ChannelDelete]:    { title: 'Channel deleted',          colour: 0xED4245 },
  [AuditLogEvent.ChannelUpdate]:    { title: 'Channel updated',          colour: 0x5865F2 },
  [AuditLogEvent.RoleCreate]:       { title: 'Role created',             colour: 0x57F287 },
  [AuditLogEvent.RoleDelete]:       { title: 'Role deleted',             colour: 0xED4245 },
  [AuditLogEvent.RoleUpdate]:       { title: 'Role updated',             colour: 0x5865F2 },
  [AuditLogEvent.MemberRoleUpdate]: { title: 'Member roles changed',     colour: 0xFEE75C },
  [AuditLogEvent.GuildUpdate]:      { title: 'Server settings changed',  colour: 0x5865F2 },
  [AuditLogEvent.InviteCreate]:     { title: 'Invite created',           colour: 0x57F287 },
  [AuditLogEvent.EmojiCreate]:      { title: 'Emoji added',              colour: 0x57F287 },
  [AuditLogEvent.EmojiDelete]:      { title: 'Emoji removed',            colour: 0xED4245 },
  [AuditLogEvent.WebhookCreate]:    { title: 'Webhook created',          colour: 0xFEE75C },
  [AuditLogEvent.WebhookDelete]:    { title: 'Webhook deleted',          colour: 0xFF7043 },
  [AuditLogEvent.WebhookUpdate]:    { title: 'Webhook changed',          colour: 0x5865F2 },
  [AuditLogEvent.MemberUpdate]:     { title: 'Nickname changed',         colour: 0x5865F2 },
  [AuditLogEvent.InviteDelete]:     { title: 'Invite deleted',           colour: 0xFF7043 },
  [AuditLogEvent.EmojiUpdate]:      { title: 'Emoji changed',            colour: 0x5865F2 },
  [AuditLogEvent.StickerCreate]:    { title: 'Sticker added',            colour: 0x57F287 },
  [AuditLogEvent.StickerDelete]:    { title: 'Sticker removed',          colour: 0xED4245 },
  [AuditLogEvent.StickerUpdate]:    { title: 'Sticker changed',          colour: 0x5865F2 },
  [AuditLogEvent.ThreadCreate]:     { title: 'Thread created',           colour: 0x57F287 },
  [AuditLogEvent.ThreadDelete]:     { title: 'Thread deleted',           colour: 0xED4245 },
  [AuditLogEvent.ThreadUpdate]:     { title: 'Thread changed',           colour: 0x5865F2 },
  [AuditLogEvent.BotAdd]:           { title: 'Bot added to the server',  colour: 0xFEE75C },
  [AuditLogEvent.IntegrationCreate]: { title: 'Integration added',       colour: 0xFEE75C },
  [AuditLogEvent.IntegrationDelete]: { title: 'Integration removed',     colour: 0xFF7043 },
  [AuditLogEvent.ChannelOverwriteCreate]: { title: 'Channel permissions added',   colour: 0xFEE75C },
  [AuditLogEvent.ChannelOverwriteUpdate]: { title: 'Channel permissions changed', colour: 0xFEE75C },
  [AuditLogEvent.ChannelOverwriteDelete]: { title: 'Channel permissions removed', colour: 0xFEE75C },
  [AuditLogEvent.AutoModerationRuleCreate]: { title: 'AutoMod rule created', colour: 0x57F287 },
  [AuditLogEvent.AutoModerationRuleUpdate]: { title: 'AutoMod rule changed', colour: 0x5865F2 },
  [AuditLogEvent.AutoModerationRuleDelete]: { title: 'AutoMod rule deleted', colour: 0xED4245 },
  [AuditLogEvent.AutoModerationBlockMessage]: { title: 'AutoMod blocked a message', colour: 0xFAA61A },
  [AuditLogEvent.AutoModerationFlagToChannel]: { title: 'AutoMod flagged a message', colour: 0xFAA61A },
  [AuditLogEvent.AutoModerationUserCommunicationDisabled]: { title: 'AutoMod timed someone out', colour: 0xFAA61A },
  [AuditLogEvent.GuildScheduledEventCreate]: { title: 'Event created',   colour: 0x57F287 },
  [AuditLogEvent.GuildScheduledEventUpdate]: { title: 'Event changed',   colour: 0x5865F2 },
  [AuditLogEvent.GuildScheduledEventDelete]: { title: 'Event cancelled', colour: 0xED4245 },
};

/**
 * A ban, kick or timeout done by hand in Discord (not through the bot) becomes a case too, so /history is complete.
 * Actions the bot took itself are skipped: they already have a case.
 */
async function recordManualAction(entry, guild) {
  try {
    if (!entry.executor || entry.executor.id === guild.client.user.id || !entry.target?.id) return;
    const mod = require('../src/moderation');
    let action = null, durationMs = null;
    if (entry.action === AuditLogEvent.MemberBanAdd) action = 'ban';
    else if (entry.action === AuditLogEvent.MemberBanRemove) action = 'unban';
    else if (entry.action === AuditLogEvent.MemberKick) action = 'kick';
    else if (entry.action === AuditLogEvent.MemberUpdate) {
      const change = entry.changes?.find(c => c.key === 'communication_disabled_until');
      if (!change?.new) return;
      action = 'timeout';
      durationMs = Math.max(0, Date.parse(change.new) - Date.now());
    }
    if (!action) return;
    const c = mod.createCase({ guildId: guild.id, user: entry.target, moderator: entry.executor, action, reason: entry.reason || null, durationMs });
    await mod.sendLog(guild, mod.caseEmbed(c, { user: entry.target }));
  } catch (err) { log('WARN', 'Could not record a manual moderation action', { err }); }
}

module.exports = {
  name: Events.GuildAuditLogEntryCreate,
  once: false,
  async execute(entry, guild) {
    await recordManualAction(entry, guild);
    const group = groupOf(entry.action);
    if (!group || !enabled(guild.id, group)) return;
    if (entry.action === AuditLogEvent.MemberUpdate) {   // only nickname changes: timeouts are cases, and other member changes are not logged
      if (!entry.changes?.some(c => c.key === 'nick')) return;
    }
    const channelId = serverRoute(guild.id, group);
    if (!channelId) return;
    try {
      const logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;
      const { title, colour } = LABELS[entry.action] || { title: 'Audit event', colour: 0x5865F2 };
      const executor = entry.executor ? `${entry.executor} — ${entry.executor.tag}` : 'Unknown';
      const embed = new EmbedBuilder().setColor(colour).setTitle(title);
      if (entry.executor) embed.setAuthor({ name: entry.executor.tag, iconURL: entry.executor.displayAvatarURL?.({ dynamic: true }) });
      embed.addFields({ name: 'By', value: executor, inline: true });
      const target = entry.target;
      if (entry.action === AuditLogEvent.MemberRoleUpdate) {
        if (target) embed.addFields({ name: 'Member', value: `${target} — ${target.tag || target.id}`, inline: true });
        const added   = entry.changes?.filter(c => c.key === '$add').flatMap(c => c.new?.map(r => `<@&${r.id}>`) || []);
        const removed = entry.changes?.filter(c => c.key === '$remove').flatMap(c => c.new?.map(r => `<@&${r.id}>`) || []);
        if (added?.length)   embed.addFields({ name: 'Roles added',   value: added.join(' '),   inline: false });
        if (removed?.length) embed.addFields({ name: 'Roles removed', value: removed.join(' '), inline: false });
        const other = fmt.lines({ changes: entry.changes?.filter(c => !['$add', '$remove'].includes(c.key)) });
        if (other.length) embed.addFields({ name: 'Changes', value: other.join('\n').slice(0, 1024), inline: false });
      } else if ([AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate].includes(entry.action)) {
        const name = target?.name || entry.changes?.find(c => c.key === 'name')?.new || '—';
        // a deleted channel can't be mentioned, so it is shown by name; otherwise the mention already shows the name
        embed.addFields({ name: 'Channel', value: target?.id && guild.channels.cache.has(target.id) ? `<#${target.id}>` : name, inline: true });
        if (entry.action === AuditLogEvent.ChannelUpdate) {
          const ch = fmt.lines(entry);
          if (ch.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0, 1024), inline: false });
        }
      } else if ([AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete].includes(entry.action)) {
        const ov = fmt.overwrite(entry);
        embed.addFields({ name: 'Channel', value: target?.id ? `<#${target.id}>` : target?.name || '—', inline: true }, { name: 'For', value: ov.who, inline: true });
        if (ov.lines.length) embed.addFields({ name: 'Permissions', value: ov.lines.join('\n').slice(0, 1024), inline: false });
      } else if ([AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate].includes(entry.action)) {
        const name = target?.name || entry.changes?.find(c=>c.key==='name')?.new || '—';
        embed.addFields({ name: 'Role', value: target?.id && guild.roles.cache.has(target.id) ? `<@&${target.id}>` : name, inline: true });
        if (entry.action === AuditLogEvent.RoleUpdate) {
          const ch = fmt.lines(entry);
          if (ch.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0, 1024), inline: false });
        }
      } else if (entry.action === AuditLogEvent.GuildUpdate) {
        const ch = fmt.lines(entry);
        if (ch.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0, 1024), inline: false });
      } else if (entry.action === AuditLogEvent.InviteCreate) {
        const code = entry.changes?.find(c=>c.key==='code')?.new || '—';
        const ch   = entry.changes?.find(c=>c.key==='channel_id')?.new;
        embed.addFields(
          { name: 'Code',    value: `discord.gg/${code}`, inline: true },
          { name: 'Channel', value: ch ? `<#${ch}>` : '—', inline: true },
        );
      } else if ([AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiDelete].includes(entry.action)) {
        const name = target?.name || '—';
        embed.addFields({ name: 'Emoji', value: target?.id ? `<:${name}:${target.id}> ${name}` : name, inline: true });
      } else if ([AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete].includes(entry.action)) {
        const ch = entry.changes?.find(c=>c.key==='channel_id')?.new;
        embed.addFields({ name: 'Webhook', value: target?.name || '—', inline: true },
          { name: 'Channel', value: ch ? `<#${ch}>` : '—', inline: true });
      }
      else if (entry.action === AuditLogEvent.MemberUpdate) {
        const nick = entry.changes?.find(c => c.key === 'nick');
        embed.addFields({ name: 'Member', value: entry.target ? `${entry.target} — ${entry.target.tag || entry.target.id}` : '—', inline: true },
          { name: 'Nickname', value: `${nick?.old ?? '*none*'} → ${nick?.new ?? '*none*'}`, inline: false });
      } else {   // everything else: what it was about, and what changed
        const t = target?.name ? `${target.name}${target.id ? ` (\`${target.id}\`)` : ''}` : target?.id ? `\`${target.id}\`` : null;
        if (t) embed.addFields({ name: 'About', value: t, inline: true });
        const ch = fmt.lines(entry);
        if (ch.length) embed.addFields({ name: 'Details', value: ch.join('\n').slice(0, 1024), inline: false });
      }
      if (entry.reason) embed.addFields({ name: 'Reason', value: entry.reason, inline: false });
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Audit log send failed', { action: entry.action, err });
    }
  },
};
