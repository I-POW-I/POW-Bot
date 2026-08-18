const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }           = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');

const TRACKED = new Set([
  AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate,
  AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.GuildUpdate, AuditLogEvent.InviteCreate,
  AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiDelete,
  AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete,
]);

const LABELS = {
  [AuditLogEvent.ChannelCreate]:    { title: 'Channel Created',          colour: 0x57F287 },
  [AuditLogEvent.ChannelDelete]:    { title: 'Channel Deleted',          colour: 0xED4245 },
  [AuditLogEvent.ChannelUpdate]:    { title: 'Channel Updated',          colour: 0x5865F2 },
  [AuditLogEvent.RoleCreate]:       { title: 'Role Created',             colour: 0x57F287 },
  [AuditLogEvent.RoleDelete]:       { title: 'Role Deleted',             colour: 0xED4245 },
  [AuditLogEvent.RoleUpdate]:       { title: 'Role Updated',             colour: 0x5865F2 },
  [AuditLogEvent.MemberRoleUpdate]: { title: 'Member Roles Changed',     colour: 0xFEE75C },
  [AuditLogEvent.GuildUpdate]:      { title: 'Server Settings Changed',  colour: 0x5865F2 },
  [AuditLogEvent.InviteCreate]:     { title: 'Invite Created',           colour: 0x57F287 },
  [AuditLogEvent.EmojiCreate]:      { title: 'Emoji Added',              colour: 0x57F287 },
  [AuditLogEvent.EmojiDelete]:      { title: 'Emoji Removed',            colour: 0xED4245 },
  [AuditLogEvent.WebhookCreate]:    { title: 'Webhook Created',          colour: 0xFEE75C },
  [AuditLogEvent.WebhookDelete]:    { title: 'Webhook Deleted',          colour: 0xFF7043 },
};

module.exports = {
  name: Events.GuildAuditLogEntryCreate,
  once: false,
  async execute(entry, guild) {
    if (!TRACKED.has(entry.action)) return;
    const channelId = getLogChannel(guild.id, 'modlog');
    if (!channelId) return;
    try {
      const logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;
      const { title, colour } = LABELS[entry.action] || { title: 'Audit Event', colour: 0x5865F2 };
      const executor = entry.executor ? `${entry.executor} — ${entry.executor.tag}` : 'Unknown';
      const embed = new EmbedBuilder().setColor(colour).setTitle(title).setTimestamp();
      if (entry.executor) embed.setAuthor({ name: entry.executor.tag, iconURL: entry.executor.displayAvatarURL?.({ dynamic: true }) });
      embed.addFields({ name: 'By', value: executor, inline: true });
      const target = entry.target;
      if (entry.action === AuditLogEvent.MemberRoleUpdate) {
        if (target) embed.addFields({ name: 'Member', value: `${target} — ${target.tag || target.id}`, inline: true });
        const added   = entry.changes?.filter(c => c.key === '$add').flatMap(c => c.new?.map(r => `<@&${r.id}>`) || []);
        const removed = entry.changes?.filter(c => c.key === '$remove').flatMap(c => c.new?.map(r => `<@&${r.id}>`) || []);
        if (added?.length)   embed.addFields({ name: 'Roles Added',   value: added.join(' '),   inline: false });
        if (removed?.length) embed.addFields({ name: 'Roles Removed', value: removed.join(' '), inline: false });
        const other = entry.changes?.filter(c => !['$add','$remove'].includes(c.key)).map(c => `**${c.key}**: ${c.old ?? '—'} → ${c.new ?? '—'}`).filter(Boolean);
        if (other?.length) embed.addFields({ name: 'Changes', value: other.join('\n').slice(0, 1024), inline: false });
      } else if ([AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate].includes(entry.action)) {
        const name = target?.name || entry.changes?.find(c=>c.key==='name')?.new || '—';
        embed.addFields({ name: 'Channel', value: target?.id ? `<#${target.id}> — ${name}` : name, inline: true });
        if (entry.action === AuditLogEvent.ChannelUpdate) {
          const ch = entry.changes?.filter(c=>c.key!=='permission_overwrites').map(c=>`**${c.key}**: ${c.old??'—'} → ${c.new??'—'}`);
          if (ch?.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0,1024), inline: false });
        }
      } else if ([AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate].includes(entry.action)) {
        const name = target?.name || entry.changes?.find(c=>c.key==='name')?.new || '—';
        embed.addFields({ name: 'Role', value: target?.id ? `<@&${target.id}> — ${name}` : name, inline: true });
        if (entry.action === AuditLogEvent.RoleUpdate) {
          const ch = entry.changes?.filter(c=>c.key!=='permissions').map(c=>`**${c.key}**: ${c.old??'—'} → ${c.new??'—'}`);
          if (ch?.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0,1024), inline: false });
        }
      } else if (entry.action === AuditLogEvent.GuildUpdate) {
        const ch = entry.changes?.filter(c=>!['icon_hash','splash_hash','banner_hash'].includes(c.key)).map(c=>`**${c.key}**: ${c.old??'—'} → ${c.new??'—'}`);
        if (ch?.length) embed.addFields({ name: 'Changes', value: ch.join('\n').slice(0,1024), inline: false });
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
      if (entry.reason) embed.addFields({ name: 'Reason', value: entry.reason, inline: false });
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Audit log send failed', { action: entry.action, error: err.message });
    }
  },
};
