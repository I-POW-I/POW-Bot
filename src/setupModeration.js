/**
 * /setup page for moderation: where the mod log goes and whether members are messaged.
 * The commands themselves (/ban, /kick, /timeout, /warn ...) work for anyone with the matching Discord permission.
 *
 * customIds: setup:moderation[:<action>]
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits: P } = require('discord.js');
const kit = require('./setupKit');
const mod = require('./moderation');
const { getLogChannel, setLogChannel, getGuildConfig, setGuildConfig } = require('./guildConfig');
const { audit } = require('./diagnostics');

const { BLUE, GREEN, AMBER, chan, noteBad, noteGood, backButton, channelSelect, respond, missingIn } = kit;

const PAGES = ['moderation'];
const owns = (page) => PAGES.includes(page);

const NEEDS = [[P.BanMembers, 'Ban Members', '/ban, /softban, /unban'], [P.KickMembers, 'Kick Members', '/kick'], [P.ModerateMembers, 'Timeout Members', '/timeout, /untimeout'], [P.ManageChannels, 'Manage Channels', '/lock, /unlock, /slowmode']];

function viewModeration(guild, user, note) {
  const s = mod.settings(guild.id);
  const logId = getLogChannel(guild.id, 'modlog');
  const missing = NEEDS.filter(([p]) => !guild.members.me.permissions.has(p));
  const total = Number(require('./database').selectOne('SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ?', [guild.id])?.n || 0);

  const embed = new EmbedBuilder().setColor(missing.length || !logId ? AMBER : GREEN).setTitle('Moderation')
    .setDescription([note,
      'Commands: `/warn` `/timeout` `/untimeout` `/kick` `/softban` `/ban` `/unban` `/lock` `/unlock` `/slowmode`, plus `/case` and `/history`. Each one needs the matching Discord permission, and every action becomes a numbered case.',
      '',
      `**Mod log:** ${logId ? chan(logId) : '*not set, choose a channel below*'}`,
      `**Message to the member:** ${s.dm ? 'on, they get a short message with the reason' : 'off'}`,
      `**Cases so far:** ${total}`,
      missing.length ? `\n**Missing permissions:** ${missing.map(([, n, c]) => `**${n}** (${c})`).join(', ')}. Give them to my role to use those commands.` : null,
    ].filter(v => v != null).join('\n'));

  return {
    embeds: [embed],
    components: [
      channelSelect('setup:moderation:log', 'Where should the mod log go?', logId),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:moderation:dm').setLabel(`Message to member: ${s.dm ? 'on' : 'off'}`).setStyle(s.dm ? ButtonStyle.Success : ButtonStyle.Secondary),
        backButton('home', 'Back to setup')),
    ],
  };
}

const VIEWS = { moderation: (guild, user, note) => viewModeration(guild, user, note) };

async function handle(interaction, { guild, by, action }) {
  const show = (note) => respond(interaction, viewModeration(guild, by, note));
  if (!action) return show();
  if (action === 'log') {
    await interaction.deferUpdate();
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    setLogChannel(guild.id, 'modlog', channel.id);
    audit({ action: 'Setup: mod log channel', actor: by, guild, details: `#${channel.name}` });
    return show(noteGood(`The mod log is now ${channel}.`));
  }
  if (action === 'dm') {
    await interaction.deferUpdate();
    const s = mod.settings(guild.id);
    setGuildConfig(guild.id, { moderation: { ...(getGuildConfig(guild.id).moderation || {}), dm: !s.dm } });
    audit({ action: 'Setup: message to moderated members', actor: by, guild, details: !s.dm ? 'on' : 'off' });
    return show(noteGood(!s.dm ? 'Members will be sent a short message when something is done to them.' : 'Members will not be messaged.'));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS, BLUE };
