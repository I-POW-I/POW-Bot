const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  MessageFlags, InteractionContextType,
} = require('discord.js');
const { isBotAdmin } = require('../src/permissions');

const BLUE = 0x5865F2;

const CATEGORIES = [
  {
    id: 'start', label: 'Getting started',
    text: [
      '**`/setup`**: set up the whole bot in one place: voice panel, logs, welcome and leave posts, verification, streamer, game and free game alerts. It shows a checklist and checks my permissions. *(Manage Server)*',
      '**`/help`**: this guide.',
      '**`/botinfo`**: full status, latency, memory and services. *(server admins)*',
      '',
      'Members don\'t need any commands. The **voice panel** does everything.',
    ],
  },
  {
    id: 'panel', label: 'Voice panel',
    text: [
      'The panel is a message with buttons that stays up to date by itself.',
      '**Join**: I join your voice channel and stay there.',
      '**Leave**: I leave. *(server owner or the bot control role)*',
      '**My info**: your voice stats: time, sessions, streaks.',
      '**User lookup**: pick someone to see their voice stats.',
      '**Leaderboard**: who has spent the most time in voice here, for all time, the last 30 days or the last 7 days.',
      '',
      'Post or move the panel in **`/setup` > Voice panel**.',
    ],
  },
  {
    id: 'alerts', label: 'Alerts and games',
    text: [
      '**`/streamers`**: who this server watches and who is live now. Staff manage the list from the button, or in **`/setup` > Streamer alerts** (Twitch, Kick, YouTube).',
      '**`/free-games`**: what is free right now on Epic and Steam. Staff turn the alerts on in **`/setup` > Free game alerts**.',
      '**`/game-updates`**: the games this server gets patch notes for. Staff add games in **`/setup` > Game update alerts** (Steam, Minecraft Java and Bedrock, Riot, Fortnite, Blizzard or any RSS feed).',
    ],
  },
  {
    id: 'members', label: 'Members and verification',
    text: [
      '**Verification**: set it up in **`/setup` > Verification**: verified role, human check, optional quarantine role, minimum account age and auto-remove. Staff get a detailed log with Approve and Kick buttons. The buttons close as soon as the member verifies.',
      '**Welcome and leave**: **`/setup` > Welcome & leave**. Choose the channel, then edit the card title, subtitle, colour and the message above it.',
      '**`/members overview | recent | pending | lookup`**: who is in the server and what\'s happening. *(Manage Server)*',
      '**`/purge`**: delete up to 100 messages. *(Manage Messages)*',
      '**Message logs**: set in **`/setup` > Logs**. To log deleted and edited messages, new messages are kept for 7 days, then deleted automatically.',
      '',
      'Verification only uses what Discord shows about an account. No emails, IPs or locations.',
    ],
  },
  {
    id: 'info', label: 'Information',
    text: [
      'Server staff can turn on **role rewards** for voice time in **`/setup` > Voice leaderboard**: pick a ladder (or make your own) and I create the roles.',
      '',
      '**`/leaderboard`**: the voice time ranking for this server.',
      '**`/changelog`**: what changed in the bot, newest first.',
      '**`/serverinfo`**: details about this server.',
      '**`/botinfo`**: status, latency, memory, services, last error. *(server admins)*',
    ],
  },
];

const OWNER_CATEGORY = {
  id: 'owner', label: 'Bot owner',
  text: [
    '**`/owner`** opens your private control panel. Everything is a section in one menu:',
    '**Overview**: system, usage, services and safety settings.',
    '**Servers**: every server, details, leave or block.',
    '**Alerts**: where errors and changes go, mute, console digest, memory restart.',
    '**Bot status**: add, edit, reorder and remove the rotating status line.',
    '**Announcements**, **Maintenance and features**, **Blocked users and servers**, **Recent changes**.',
    'On the home screen: **Restart bot**, **Console logs** and **Send digest**.',
  ],
};

const categoriesFor = (userId) => isBotAdmin(userId) ? [...CATEGORIES, OWNER_CATEGORY] : CATEGORIES;

function buildHome(userId) {
  const cats = categoriesFor(userId);
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('POW-Bot help')
    .setDescription('Pick a topic below. Admins: start with **`/setup`**.\n\n' + cats.map(c => `**${c.label}**`).join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('help:cat').setPlaceholder('Choose a topic…')
    .addOptions(cats.map(c => ({ label: c.label, value: c.id })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildCategory(userId, id) {
  const cats = categoriesFor(userId);
  const cat = cats.find(c => c.id === id) || cats[0];
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(cat.label).setDescription(cat.text.join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('help:cat').setPlaceholder('Choose a topic…')
    .addOptions(cats.map(c => ({ label: c.label, value: c.id, default: c.id === cat.id })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use the bot and what each command does')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),

  async execute(interaction) {
    return interaction.reply({ ...buildHome(interaction.user.id), flags: [MessageFlags.Ephemeral] });
  },

  /** Category menu. Returns true when handled. */
  async handleComponent(interaction) {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'help:cat') return false;
    await interaction.update(buildCategory(interaction.user.id, interaction.values[0]));
    return true;
  },

  _buildHome: buildHome, _buildCategory: buildCategory,
};
