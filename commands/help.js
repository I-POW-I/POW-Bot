const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  MessageFlags, InteractionContextType,
} = require('discord.js');
const { isBotAdmin } = require('../src/permissions');

const BLUE = 0x5865F2;

const CATEGORIES = [
  {
    id: 'start', label: 'Getting started', emoji: '🚀',
    text: [
      '**`/setup`** — configure everything in one place: voice panel, logs, welcome cards, verification, alerts. It shows a checklist and checks my permissions. *(Manage Server)*',
      '**`/help`** — this guide.',
      '**`/botinfo`** — my status, latency and resource use.',
      '',
      'Members don\'t need any commands — the **voice panel** does everything.',
    ],
  },
  {
    id: 'panel', label: 'Voice panel', emoji: '🎛️',
    text: [
      'The panel is a message with buttons that stays up to date by itself.',
      '**Join** — I join your voice channel and stay there.',
      '**Leave** — I leave. *(server owner or the bot control role)*',
      '**My Info** — your voice stats: time, sessions, streaks.',
      '**User Lookup** — pick someone to see their voice stats.',
      '**Bot Info** — my status and health.',
      '',
      'Post or move the panel in **`/setup` → Voice panel**.',
    ],
  },
  {
    id: 'alerts', label: 'Alerts & games', emoji: '📺',
    text: [
      '**`/streamers add | remove | list`** — go-live alerts for Twitch, Kick and YouTube. *(Manage Server)*',
      '**`/free-games now | setup | edit | remove | status`** — free games on Epic and Steam. `now` is open to everyone; the rest need *Manage Server*.',
      '**`/game-updates add | edit | remove | list | test`** — patch notes for Steam games. *(Manage Server)*',
    ],
  },
  {
    id: 'members', label: 'Members & verification', emoji: '🛡️',
    text: [
      '**Verification** — set it up in **`/setup` → Verification**: verified role, human check, optional quarantine role, minimum account age and auto-remove. Staff get a detailed log with Approve / Kick buttons.',
      '**`/members overview | recent | pending | lookup`** — who is in the server and what\'s happening. *(Manage Server)*',
      '**`/purge`** — delete up to 100 messages. *(Manage Messages)*',
      '',
      'Verification only uses what Discord shows about an account — no emails, IPs or locations.',
    ],
  },
  {
    id: 'info', label: 'Information', emoji: 'ℹ️',
    text: [
      '**`/serverinfo`** — details about this server.',
      '**`/botinfo`** — status, latency, RAM, services, last error.',
    ],
  },
];

const OWNER_CATEGORY = {
  id: 'owner', label: 'Bot owner', emoji: '🔧',
  text: [
    '**`/owner status`** — system, usage, services and safety settings.',
    '**`/owner restart`** — restart through Discloud (asks to confirm).',
    '**`/owner logs`** · **`digest`** · **`alerts`** · **`audit`** — console, hourly digest, alert tests/mute, change history.',
    '**`/owner servers`** · **`server info | leave | ban | unban`** — every server the bot is in.',
    '**`/owner announce`** — message every server. **`maintenance`**, **`features`**, **`block-user`**, **`unblock-user`**, **`blocked`**, **`commands`**, **`panels`**.',
  ],
};

const categoriesFor = (userId) => isBotAdmin(userId) ? [...CATEGORIES, OWNER_CATEGORY] : CATEGORIES;

function buildHome(userId) {
  const cats = categoriesFor(userId);
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('POW-Bot — help')
    .setDescription('Pick a topic below. Admins: start with **`/setup`**.\n\n' + cats.map(c => `${c.emoji} **${c.label}**`).join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('help:cat').setPlaceholder('Choose a topic…')
    .addOptions(cats.map(c => ({ label: c.label, value: c.id, emoji: c.emoji })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildCategory(userId, id) {
  const cats = categoriesFor(userId);
  const cat = cats.find(c => c.id === id) || cats[0];
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`${cat.emoji} ${cat.label}`).setDescription(cat.text.join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('help:cat').setPlaceholder('Choose a topic…')
    .addOptions(cats.map(c => ({ label: c.label, value: c.id, emoji: c.emoji, default: c.id === cat.id })));
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
