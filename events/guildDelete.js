const { Events } = require('discord.js');
const { audit }  = require('../src/diagnostics');

module.exports = {
  name: Events.GuildDelete,
  once: false,

  async execute(guild) {
    if (guild.available === false) return;   // a Discord outage, not a removal
    audit({ action: 'Left / removed from a server', guild: { name: guild.name || guild.id }, details: `${guild.memberCount ?? '?'} members` });
  },
};
