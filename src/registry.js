const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

/**
 * Scans the /commands folder and loads every .js file onto client.commands.
 * Each command file must export: { data: SlashCommandBuilder, execute(interaction) }
 * @param {import('discord.js').Client} client
 */
function loadCommands(client) {
  client.commands = new Map();

  const commandsPath = path.join(__dirname, '..', 'commands');
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

  for (const file of files) {
    let command;
    try {
      command = require(path.join(commandsPath, file));
    } catch (error) {
      // One broken file must never stop the whole bot from starting
      log('ERROR', `Could not load commands/${file}: ${error.message}`);
      continue;
    }

    if (!command.data || !command.execute) {
      log('WARN', `Skipping ${file} — missing data or execute export`);
      continue;
    }

    client.commands.set(command.data.name, command);
    log('INFO', `Loaded command: /${command.data.name}`);
  }
}

/**
 * Scans the /events folder and registers every .js file as a Discord event.
 * Each event file must export: { name, once (bool), execute(...args, client) }
 * @param {import('discord.js').Client} client
 */
function loadEvents(client) {
  const eventsPath = path.join(__dirname, '..', 'events');
  const files = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const event = require(path.join(eventsPath, file));

    if (!event.name || !event.execute) {
      log('WARN', `Skipping event ${file} — missing name or execute export`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }

    log('INFO', `Registered event: ${event.name}${event.once ? ' (once)' : ''}`);
  }
}

module.exports = { loadCommands, loadEvents };