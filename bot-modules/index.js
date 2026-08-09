/*
 * POW Bot — feature modules index
 * Drop this whole `bot-modules/` folder into your 247-Pow-Bot repo
 * (e.g. at the repo root) and wire it up in src/index.js as shown in README.md.
 */

const automod = require('./automod');
const customCommands = require('./custom-commands');
const reactionRoles = require('./reaction-roles');
const tickets = require('./tickets');
const webhooks = require('./webhooks');

function register(client) {
  client.on('messageCreate', async (message) => {
    // Automod first; if it acts it returns early. Custom commands run regardless
    // of whether automod triggered (automod itself short-circuits per message).
    await automod.evaluate(message);
    await customCommands.handleMessage(message);
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    await reactionRoles.handleAdd(reaction, user);
  });
  client.on('messageReactionRemove', async (reaction, user) => {
    await reactionRoles.handleRemove(reaction, user);
  });

  client.on('guildMemberAdd', async (member) => {
    await webhooks.onGuildMemberAdd(member);
  });
  client.on('guildMemberRemove', async (member) => {
    await webhooks.onGuildMemberRemove(member);
  });

  client.on('interactionCreate', async (interaction) => {
    await tickets.handleButton(interaction);
  });

  client.on('ready', async () => {
    console.log('[bot-modules] registering — ensuring ticket panels for all guilds');
    for (const guild of client.guilds.cache.values()) {
      await tickets.ensurePanel(client, guild.id).catch((e) =>
        console.error(`[tickets] panel ensure failed for ${guild.id}:`, e.message)
      );
    }
    // Periodic refresh so newly-enabled ticket panels appear without a restart
    setInterval(async () => {
      for (const guild of client.guilds.cache.values()) {
        await tickets.ensurePanel(client, guild.id).catch(() => {});
      }
    }, 300_000).unref();
  });

  // Optional: invalidate caches when the dashboard signals a config change.
  // If you expose a webhook from the dashboard, call the relevant invalidateCache.
}

module.exports = {
  register,
  automod,
  customCommands,
  reactionRoles,
  tickets,
  webhooks,
};
