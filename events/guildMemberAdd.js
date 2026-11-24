const { Events } = require('discord.js');
const { log }            = require('../src/logger');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    const { guild } = member;
    const user      = member.user;

    // ── 1. Welcome post, welcome message to the member and join roles (see src/welcome.js) ──
    try { await require('../src/welcome').onJoin(member); }
    catch (err) { log('WARN', 'Welcome handling failed', { guild: guild.name, err }); }

    // ── 2. Member join log + verification (see src/verification.js) ──────────
    try {
      await require('../src/verification').onMemberJoin(member);
    } catch (err) {
      log('ERROR', 'Member join handling failed', { guild: guild.name, user: user.tag, err });
    }
  },
};
