/*
 * POW Bot — modified client.js with added intents for dashboard modules
 *
 * Drop this file into your bot's src/ folder, replacing the existing client.js.
 *
 * Changes from original:
 * - Added GuildMessageReactions intent (needed for reaction roles)
 * - Added Partials for Message, Reaction, and Channel (needed so reaction
 *   events fire on old/partial messages)
 * - Added GuildPresences intent (needed if you use presence-based features)
 *
 * Your existing voice/24-7 intents are preserved exactly.
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
  intents: [
    // ── Existing intents (unchanged) ─────────────────────────────────────────
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,        // Member info in voice logs
    GatewayIntentBits.GuildMessages,       // Message delete events
    GatewayIntentBits.MessageContent,      // Read deleted message content (privileged)

    // ── New intents for dashboard modules ────────────────────────────────────
    GatewayIntentBits.GuildMessageReactions, // Reaction roles
    GatewayIntentBits.GuildPresences,        // Presence-based features (optional)
  ],
  partials: [
    Partials.Message,   // Reaction roles — fetch old messages
    Partials.Reaction,  // Reaction roles — partial reaction events
    Partials.Channel,   // Reaction roles — partial channel fetches
  ],
});

module.exports = client;
