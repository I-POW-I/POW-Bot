const { Events, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { log }            = require('../src/logger');
const { getLogChannel }  = require('../src/guildConfig');
const { getWelcomeConfig } = require('../src/welcomeConfig');
const { generateCard }   = require('../src/imageGenerator');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    const { guild } = member;
    const welcomeConfig = await getWelcomeConfig(guild.id);
    const user      = member.user;

    // ── 1. Welcome image card ─────────────────────────────────────────────────
    if (welcomeConfig.welcomeChannelId) {
      try {
        const channel = await guild.channels.fetch(welcomeConfig.welcomeChannelId);
        if (channel?.isTextBased()) {
          const buffer = await generateCard(
            'welcome',
            { nickname: member.nickname, username: user.username },
            user.displayAvatarURL({ dynamic: false, size: 512 }),
            guild.memberCount,
            welcomeConfig.cardConfig
          );
          await channel.send({ content: `${member}`, files: [new AttachmentBuilder(buffer, { name: 'welcome.png' })] });
        }
      } catch (err) {
        log('WARN', 'Failed to send welcome card', { error: err.message });
      }
    }

    // ── 2. Member join log ────────────────────────────────────────────────────
    const channelId = getLogChannel(guild.id, 'members');
    if (!channelId) return;
    try {
      const logChannel = await guild.channels.fetch(channelId);
      if (!logChannel?.isTextBased()) return;

      const ageMs     = Date.now() - user.createdAt.getTime();
      const ageInDays = Math.floor(ageMs / 86400000);
      const isNew     = ageInDays < 7;
      const isSuspect = ageInDays < 30;
      const ageStr    = ageInDays > 365
        ? `${Math.floor(ageInDays / 365)}y ${Math.floor((ageInDays % 365) / 30)}m`
        : ageInDays > 30 ? `${Math.floor(ageInDays / 30)} month(s)` : `${ageInDays} day(s)`;

      // Alt account indicators
      const flags = [];
      if (isNew)                                    flags.push('Account under 7 days old');
      if (isSuspect && !isNew)                      flags.push('Account under 30 days old');
      if (user.username.match(/\d{4,}$/))          flags.push('Username ends in many numbers');
      if (user.username.match(/^[a-z]+\d{4,}$/i))  flags.push('Username pattern common on alts');
      if (!user.avatar)                             flags.push('No profile picture (default avatar)');
      if (user.bot)                                 flags.push('Bot account');

      const embed = new EmbedBuilder()
        .setColor(isNew ? 0xED4245 : isSuspect ? 0xFEE75C : 0x57F287)
        .setTitle(isNew ? 'New Account Joined' : 'Member Joined')
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'Member',        value: `${member} — ${user.tag}`,                                      inline: false },
          { name: 'Account Age',   value: ageStr,                                                          inline: true  },
          { name: 'Created',       value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:D>`,         inline: true  },
          { name: 'Member Count',  value: `${guild.memberCount}`,                                         inline: true  },
          { name: 'Account Type',  value: user.bot ? 'Bot' : 'User',                                      inline: true  },
          { name: 'Default Avatar',value: user.avatar ? 'No' : 'Yes',                                     inline: true  },
          { name: 'User ID',       value: user.id,                                                        inline: true  },
        )
        .setTimestamp();

      if (flags.length > 0) {
        embed.setDescription(`⚠️ **Possible alt account indicators:**\n${flags.map(f => `• ${f}`).join('\n')}`);
      }

      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      log('WARN', 'Failed to send member join log', { error: err.message });
    }
  },
};
