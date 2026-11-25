const { Events } = require('discord.js');

// Counts reactions (a number per member, day, hour and channel) in servers that turned on Wrapped counting. Nothing about
// what was reacted to or with is kept. See src/activity.js
module.exports = {
  name: Events.MessageReactionAdd,
  once: false,

  async execute(reaction, user) {
    try { require('../src/activity').recordReaction(reaction, user); } catch { /* counting is best-effort */ }
  },
};
