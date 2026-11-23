const { Events, AttachmentBuilder } = require('discord.js');
const { log }            = require('../src/logger');
const { getGuildConfig } = require('../src/guildConfig');
const { generateCard }   = require('../src/imageGenerator');
const cards              = require('../src/cards');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    const { guild } = member;
    const config    = getGuildConfig(guild.id);
    const user      = member.user;

    // ── 1. Welcome post (text + image card, customised in /setup → Welcome & leave) ──
    if (config.welcomeChannelId && config.welcomeEnabled !== false) {
      try {
        const channel = await guild.channels.fetch(config.welcomeChannelId);
        if (channel?.isTextBased()) {
          const name = member.displayName || user.username;
          const post = cards.compose(guild.id, 'welcome', { user: name, mention: `${member}`, server: guild.name, count: guild.memberCount });
          const payload = { allowedMentions: { users: [member.id] } };
          if (post.text) payload.content = post.text;
          if (post.card) {
            const buffer = await generateCard('welcome', name, user.displayAvatarURL({ dynamic: false, size: 512 }), guild.memberCount, post.image);
            payload.files = [new AttachmentBuilder(buffer, { name: 'welcome.png' })];
          }
          if (payload.content || payload.files) await channel.send(payload);
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
