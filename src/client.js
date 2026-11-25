const { Client, GatewayIntentBits, Partials, Options } = require('discord.js');

const client = new Client({
  // Keep the caches small: the bot keeps its own copy of messages it needs (the database), so Discord.js does not have to
  // hold hundreds of messages per channel in memory. Members, channels and roles stay cached as before.
  makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 30, PresenceManager: 0 }),
  sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 300, lifetime: 900 } },   // forget cached messages after 15 minutes
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,           // Member info in voice logs
    GatewayIntentBits.GuildMessages,          // Message delete events
    GatewayIntentBits.GuildMessageReactions,  // Reaction counts for Wrapped (counted per member, never stored with the message)
    GatewayIntentBits.MessageContent,         // Read deleted message content (privileged)
    GatewayIntentBits.GuildModeration,        // Audit log events (also covers emoji / invite logs)
  ],
  partials: [
    Partials.Message,                         // CRITICAL: Forces tracking on old/uncached text drops
    Partials.Channel,                         // Allows processing of historical text rooms
    Partials.Reaction,                        // Reactions on messages the bot has not cached
  ],
});

module.exports = client;
