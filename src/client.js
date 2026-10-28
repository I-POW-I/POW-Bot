const { Client, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,           // Member info in voice logs
    GatewayIntentBits.GuildMessages,          // Message delete events
    GatewayIntentBits.MessageContent,         // Read deleted message content (privileged)
    GatewayIntentBits.GuildModeration,        // Audit log events
    GatewayIntentBits.GuildEmojisAndStickers, // Emoji add/remove logs
    GatewayIntentBits.GuildInvites,           // Invite create logs
  ],
  partials: [
    Partials.Message,                         // CRITICAL: Forces tracking on old/uncached text drops
    Partials.Channel,                         // Allows processing of historical text rooms
  ],
});

module.exports = client;
