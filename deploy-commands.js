/**
 * Run this manually when you add/change/remove slash commands:
 *   node deploy-commands.js
 *
 * The bot itself also re-registers on startup (in events/ready.js),
 * but running this manually is useful during development.
 */

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('BOT_TOKEN or CLIENT_ID missing from .env');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of files) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
    console.log(`  Loaded: /${command.data.name}`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`\nDeploying ${commands.length} global command(s)...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('All commands deployed globally. May take up to 1 hour to appear everywhere.');
  } catch (err) {
    console.error('Deploy failed:', err.message);
  }
})();
