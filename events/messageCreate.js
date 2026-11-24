const { Events }  = require('discord.js');
const store       = require('../src/messageStore');
const { log }     = require('../src/logger');

// Keeps new messages for 7 days (only in servers with a Message log channel) so deleted / edited
// messages can always be logged — see src/messageStore.js
module.exports = {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    require('../src/checkpoint').handleMessage(message).catch(err => log('WARN', 'Security Check Point error', { err }));
    try { store.record(message); }
    catch (err) { log('WARN', 'Could not store a message for the delete log', { err }); }
  },
};
