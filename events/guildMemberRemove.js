const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { log }                    = require('../src/logger');
const { getLogChannel } = require('../src/guildConfig');
const { duration } = require('../src/duration');

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
    const kick      = await getKicker(guild, member.id);

    // Keep the member history up to date (feeds /members and the verification log)
    try { require('../src/verification').onMemberLeave(member); }
    catch (err) { log('WARN', 'Could not record member leave', { guild: guild.name, err }); }

    // ── 1. Leave post (see src/welcome.js) ────────────────────────────────────
    await require('../src/welcome').onLeave(member);

    // ── 2. Admin log embed ────────────────────────────────────────────────────
    const logChannelId = getLogChannel(guild.id, 'members');
    if (!logChannelId) return;

    try {
      const logChannel = await guild.channels.fetch(logChannelId);
      if (!logChannel?.isTextBased()) return;

      const user    = member.user;
      const joinedAt = member.joinedAt;
      const timeInServer = joinedAt ? duration(Date.now() - joinedAt.getTime()) : 'Unknown';

      const roles = member.roles?.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .first(5)
        .map(r => `<@&${r.id}>`);

      const embed = new EmbedBuilder()
        .setColor(kick ? 0xFF7043 : 0xED4245)
        .setTitle(kick ? '👢 Member kicked' : '👋 Member left')
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'Member',         value: `${user} — ${user.tag}`, inline: false },
          { name: 'Time in Server', value: timeInServer,             inline: true  },
          { name: 'Member count',   value: `${guild.memberCount}`,   inline: true  },
          { name: '\u200b',         value: '\u200b',                 inline: true  },
        );

      if (kick) {
        embed.addFields(
          { name: 'Kicked by', value: kick.mention, inline: true  },
          { name: 'Reason',    value: kick.reason,  inline: false },
        );
      }

      if (roles?.length > 0) {
        embed.addFields({ name: 'Roles', value: roles.join(' '), inline: false });
      }

      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send member leave log', { err });
    }
  },
};
