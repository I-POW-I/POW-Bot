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
      '**`/botinfo`**: status, latency and version.',
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
      '**`/free-games`**: what is free right now on Epic, Steam and GOG. Staff turn the alerts on in **`/setup` > Free game alerts**.',
      '**`/game-updates`**: the games this server gets patch notes for. Staff add games in **`/setup` > Game update alerts** (Steam, Minecraft Java and Bedrock, Riot or any RSS feed).',
    ],
  },
  {
    id: 'mod', label: 'Moderation',
    text: [
      'For staff. Each command needs the matching Discord permission, and every action becomes a numbered case with a reason, recorded in the mod log.',
      '',
      '**`/warn`**, **`/timeout`**, **`/untimeout`**, **`/kick`**, **`/softban`**, **`/ban`**, **`/unban`**: act on a member. The member is sent a short message with the reason (staff can turn that off in **`/setup` > Moderation**).',
      '**`/softban`** bans and unbans straight away, which deletes their recent messages. They can rejoin.',
      '**`/case`**: look up a case by number, or change its reason.',
      '**`/history`**: every case for one member.',
      '**`/lock`**, **`/unlock`**, **`/slowmode`**: control a channel.',
      '**`/purge`**: delete up to 100 messages.',
      '',
      'Bans, kicks and timeouts done by hand in Discord are recorded as cases too. **`/setup` > Security Check Point** adds a trap channel that catches spam bots and hacked accounts.',
      '',
      '**Raid protection**: **`/setup` > Raid protection**. Detects a flood of new joins (you choose how many, how fast), then alerts staff or starts **raid mode**: new accounts you choose are kicked, timed out or banned and invites are paused. Also an account age gate. Turn raid mode on or off yourself with **`/raidmode`**. *(Manage Server)*',
      '**AutoMod**: **`/setup` > AutoMod**. Switch on filters for invite links, scam links, all links, message spam, mass mentions, capitals, emoji and your own blocked words. Each has its own response (delete, warn or time out), strikes add up to a timeout, and staff, roles and channels you pick are ignored. One button also adds Discord\'s own built-in AutoMod rules.',
    ],
  },
  {
    id: 'members', label: 'Members and verification',
    text: [
      '**Verification**: set it up in **`/setup` > Verification**: verified role, human check, optional quarantine role, minimum account age and auto-remove. Staff get a detailed log with Approve and Kick buttons. The buttons close as soon as the member verifies.',
      '**Welcome and leave**: **`/setup` > Welcome & leave**. Choose the channel, then pick how each post looks (image card, rich embed, both or text), a card style, and your own wording with placeholders like `{ordinal}` and `{accountage}`. **Extras** adds a private welcome message, roles for new members and a welcome-back line. **Preview** shows exactly what will be posted.',
      '**`/members overview | recent | pending | lookup`**: who is in the server and what\'s happening. *(Manage Server)*',
      '**`/purge`**: delete up to 100 messages. *(Manage Messages)*',
      '**Logs**: set in **`/setup` > Logs**. Pick a log, choose its channel, and switch each kind of event on or off. **Server changes** records channels, roles, nicknames, emoji, invites, threads, webhooks, AutoMod and server settings, with who did it. Message logs can ignore channels, roles, people and bots (**Ignore lists**), voice logs can switch each kind of event off, and Server changes can go to a separate channel for each kind (**Route by kind**). To log deleted and edited messages, new messages are kept for 7 days, then deleted automatically.',
      '',
      'Verification only uses what Discord shows about an account. No emails, IPs or locations.',
    ],
  },
  {
    id: 'info', label: 'Information',
    text: [
      'Server staff can turn on **role rewards** for voice time in **`/setup` > Voice leaderboard**: pick a ladder (or make your own) and I create the roles. You can also have the leaderboard posted weekly or monthly.',
      '',
      '**`/leaderboard`**: the voice time ranking for this server.',
      '**`/changelog`**: what changed in the bot, newest first.',
      '**`/privacy`**: see what the bot has stored about you and delete it.',
      '**`/serverinfo`**: details about this server.',
      '**`/botinfo`**: status, latency and version. The bot owner also gets the full system details privately.',
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
    'On the home screen: **Restart bot**, **Console logs** and **Send digest**. In Alerts, **Digest and memory** sets how often the digest is sent and whether it goes to your webhook, your DMs or both.',
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
