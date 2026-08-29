const { Events, EmbedBuilder, AuditLogEvent, AttachmentBuilder } = require('discord.js');
const { log }                    = require('../src/logger');
const { getLogChannel }          = require('../src/guildConfig');
const { getWelcomeConfig }       = require('../src/welcomeConfig');
const { generateCard }           = require('../src/imageGenerator');

async function getKicker(guild, userId, windowMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 3 });
    const entry = logs.entries.find(e =>
      e.target?.id === userId && (Date.now() - e.createdTimestamp) < windowMs
    );
    if (!entry) return null;
    return {
      mention: `${entry.executor} — ${entry.executor.tag}`,
      reason:  entry.reason || 'No reason provided',
    };
  } catch { return null; }
}

module.exports = {
  name: Events.GuildMemberRemove,
  once: false,

  async execute(member) {
    const { guild } = member;
    const welcomeConfig = await getWelcomeConfig(guild.id);
    const kick      = await getKicker(guild, member.id);

    // ── 1. Leave image card ───────────────────────────────────────────────────
    const leaveChannelId = welcomeConfig.leaveChannelId || welcomeConfig.welcomeChannelId;
    if (leaveChannelId) {
      try {
        const channel = await guild.channels.fetch(leaveChannelId);
        if (channel?.isTextBased()) {
          const avatarUrl   = member.user.displayAvatarURL({ dynamic: false, size: 512 });
          const buffer      = await generateCard(
            'leave',
            { nickname: member.nickname, username: member.user.username },
            avatarUrl,
            guild.memberCount,
            welcomeConfig.cardConfig
          );
          await channel.send({ files: [new AttachmentBuilder(buffer, { name: 'leave.png' })] });
        }
      } catch (err) {
        log('WARN', 'Failed to send leave card', { error: err.message });
      }
    }

    // ── 2. Admin log embed ────────────────────────────────────────────────────
    const logChannelId = getLogChannel(guild.id, 'members');
    if (!logChannelId) return;

    try {
      const logChannel = await guild.channels.fetch(logChannelId);
      if (!logChannel?.isTextBased()) return;

      const user    = member.user;
      const joinedAt = member.joinedAt;
      const timeInServer = joinedAt ? (() => {
        const diff = Date.now() - joinedAt.getTime();
        const d    = Math.floor(diff / 86400000);
        const h    = Math.floor((diff % 86400000) / 3600000);
        return d > 0 ? `${d}d ${h}h` : `${h}h`;
      })() : 'Unknown';

      const roles = member.roles?.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .first(5)
        .map(r => `<@&${r.id}>`);

      const embed = new EmbedBuilder()
        .setColor(kick ? 0xFF7043 : 0xED4245)
        .setTitle(kick ? 'Member Kicked' : 'Member Left')
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'Member',         value: `${user} — ${user.tag}`, inline: false },
          { name: 'Time in Server', value: timeInServer,             inline: true  },
          { name: 'Member Count',   value: `${guild.memberCount}`,   inline: true  },
          { name: '\u200b',         value: '\u200b',                 inline: true  },
        )
        .setTimestamp();

      if (kick) {
        embed.addFields(
          { name: 'Kicked By', value: kick.mention, inline: true  },
          { name: 'Reason',    value: kick.reason,  inline: false },
        );
      }

      if (roles?.length > 0) {
        embed.addFields({ name: 'Roles', value: roles.join(' '), inline: false });
      }

      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send member leave log', { error: err.message });
    }
  },
};
