const { Events, AttachmentBuilder } = require('discord.js');
const { log }            = require('../src/logger');
const { getGuildConfig } = require('../src/guildConfig');
const { generateCard }   = require('../src/imageGenerator');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    const { guild } = member;
    const config    = getGuildConfig(guild.id);
    const user      = member.user;

    // ── 1. Welcome image card ─────────────────────────────────────────────────
    if (config.welcomeChannelId && config.welcomeEnabled !== false) {
      try {
        const channel = await guild.channels.fetch(config.welcomeChannelId);
        if (channel?.isTextBased()) {
          const buffer = await generateCard('welcome', member.displayName || user.username,
            user.displayAvatarURL({ dynamic: false, size: 512 }), guild.memberCount);
          await channel.send({ content: `${member}`, files: [new AttachmentBuilder(buffer, { name: 'welcome.png' })] });
        }
      } catch (err) {
        log('WARN', 'Failed to send welcome card', { err });
      }
    }

    // ── 2. Member join log + verification (see src/verification.js) ──────────
    try {
      await require('../src/verification').onMemberJoin(member);
    } catch (err) {
      log('ERROR', 'Member join handling failed', { guild: guild.name, user: user.tag, err });
    }
  },
};
