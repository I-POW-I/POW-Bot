const { Events } = require('discord.js');
const { log }            = require('../src/logger');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    const { guild } = member;
    const user      = member.user;

    // ── 0. Raid protection: a member removed here gets no welcome post and no verification (see src/raid.js) ──
    try { if (await require('../src/raid').onJoin(member)) return; }
    catch (err) { log('WARN', 'Raid protection failed', { guild: guild.name, err }); }

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
