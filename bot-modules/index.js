/*
 * POW Bot — feature modules index
 * Drop this whole `bot-modules/` folder into your 247-Pow-Bot repo
 * (e.g. at the repo root) and wire it up in src/index.js as shown in README.md.
 */

/*
 * POW Bot — feature modules index
 * Drop this whole `bot-modules/` folder into your 247-Pow-Bot repo
 * (e.g. at the repo root) and wire it up in src/index.js as shown in README.md.
 *
 * webhooks and tickets are intentionally deleted
 */

const automod = require('./automod');
const customCommands = require('./custom-commands');
const reactionRoles = require('./reaction-roles');

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
}

module.exports = {
  register,
  automod,
  customCommands,
  reactionRoles,
};
