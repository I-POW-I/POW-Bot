/**
 * /setup > Wrapped: message and reaction counting, and the December Server Wrapped post.
 *
 * Voice stats need no setup. Counting is what lets My Server Time Wrapped show messages sent and reactions given: numbers only,
 * never text. It is off until a server switches it on, and starts counting from that moment.
 *
 * customIds: setup:wrapped[:count|auto|now|chan|ann|day|erase|erase_yes]
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const kit = require('./setupKit');
const activity = require('./activity');
const wrapped = require('./wrapped');
const { audit } = require('./diagnostics');
const { selectOne } = require('./database');
const { log } = require('./logger');

const { chan, onOff, noteBad, noteGood, backButton, channelSelect, missingIn, respond } = kit;
const PAGES = ['wrapped'];
const owns = (page) => PAGES.includes(page);

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const since = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function viewWrapped(guild, user, note) {
  const s = activity.settings(guild.id);
  const stored = Number(selectOne('SELECT COUNT(*) AS n FROM activity WHERE guild_id = ?', [guild.id])?.n || 0);
  const lines = [note,
    'Members can open **My Server Time Wrapped** from the voice panel at any time. Voice time needs no setup. **Counting** adds messages sent and reactions given.',
    '',
    `**Counting:** ${s.counting ? `on, counting since ${since(s.countingSince)}` : 'off'}`,
    '*Counts only, never what anyone wrote: how many messages and reactions each member sends per day, hour and channel. Bots are not counted. Wrapped can only cover the time since counting began.*',
    '',
    `**December post:** ${s.autoPost ? `on, in ${chan(s.channelId)} on ${s.day} December` : 'off'}`,
    '*Posts Server Wrapped with a button so members can open their own.*',
    stored ? `\n${stored.toLocaleString('en-GB')} count rows stored for this server.` : null,
  ].filter(v => v !== null && v !== undefined).join('\n');

  const dayOptions = Array.from({ length: 25 }, (_, i) => ({ label: `${i + 1} December`, value: String(i + 1), default: (s.day || 1) === i + 1 }));
  const ann = kit.announcementButton('setup:wrapped:ann', guild);
  return {
    embeds: [new EmbedBuilder().setColor(0xFFC857).setAuthor({ name: 'Setup · Wrapped' }).setTitle('Wrapped').setDescription(lines)],
    components: [
      row(btn('setup:wrapped:count', `Counting: ${onOff(s.counting)}`, s.counting ? ButtonStyle.Success : ButtonStyle.Secondary),
        btn('setup:wrapped:auto', `December post: ${onOff(s.autoPost)}`, s.autoPost ? ButtonStyle.Success : ButtonStyle.Secondary),
        btn('setup:wrapped:now', 'Post now', ButtonStyle.Primary, !s.channelId)),
      channelSelect('setup:wrapped:chan', 'Channel for the December post', s.channelId),
      row(new StringSelectMenuBuilder().setCustomId('setup:wrapped:day').setPlaceholder('Day in December').addOptions(dayOptions)),
      row(...[ann, btn('setup:wrapped:erase', 'Erase counts', ButtonStyle.Danger, !stored), backButton()].filter(Boolean)),
    ],
  };
}

function viewErase(guild) {
  return {
    embeds: [new EmbedBuilder().setColor(0xED4245).setAuthor({ name: 'Setup · Wrapped' }).setTitle('Erase counts?').setDescription('This deletes every message and reaction count stored for this server. Voice stats are not touched. Counting stays as it is, and starts again from now if it is on.')],
    components: [row(btn('setup:wrapped:erase_yes', 'Yes, erase', ButtonStyle.Danger), btn('setup:wrapped', 'Cancel'))],
  };
}

const VIEWS = { wrapped: (guild, user, note) => viewWrapped(guild, user, note) };

async function handle(interaction, { guild, by, action }) {
  const show = (note) => respond(interaction, viewWrapped(guild, by, note));
  const done = (a, d) => audit({ action: `Setup: ${a}`, actor: by, guild, details: d });
  const s = activity.settings(guild.id);

  if (!action) return show();
  if (action === 'count') {
    activity.setCounting(guild.id, !s.counting);
    done(`Wrapped counting ${s.counting ? 'off' : 'on'}`);
    return show(noteGood(s.counting ? 'Counting is off. Nothing new is counted.' : 'Counting is on. Messages and reactions are counted from now.'));
  }
  if (action === 'auto') {
    if (!s.autoPost && !s.channelId) return show(noteBad('Choose a channel first.'));
    activity.setSettings(guild.id, { autoPost: !s.autoPost });
    done(`Wrapped December post ${s.autoPost ? 'off' : 'on'}`);
    return show(noteGood(s.autoPost ? 'The December post is off.' : `Server Wrapped will be posted in ${chan(s.channelId)} on ${s.day} December.`));
  }
  if (action === 'chan' || action === 'ann') {
    const channel = action === 'ann' ? kit.announcementChannel(guild) : interaction.channels.first();
    if (!channel) return show(noteBad('I could not find that channel.'));
    const missing = missingIn(channel, guild, [...kit.POST_PERMS, 'AttachFiles']);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    activity.setSettings(guild.id, { channelId: channel.id });
    done('Wrapped channel set', `→ #${channel.name}`);
    return show(noteGood(`The December post goes to ${channel}.`));
  }
  if (action === 'day') {
    const day = Number(interaction.values[0]);
    if (!(day >= 1 && day <= 25)) return show(noteBad('Choose a day between 1 and 25 December.'));
    activity.setSettings(guild.id, { day, postedYear: s.postedYear });
    done('Wrapped post day set', `${day} December`);
    return show(noteGood(`Server Wrapped will post on ${day} December.`));
  }
  if (action === 'now') {
    const channel = s.channelId && guild.channels.cache.get(s.channelId);
    if (!channel) return show(noteBad('Choose a channel first.'));
    const missing = missingIn(channel, guild, [...kit.POST_PERMS, 'AttachFiles']);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    try { await channel.send({ ...(await wrapped.serverWrapped(guild)), components: wrapped.wrappedButtons() }); }
    catch (err) { log('WARN', 'Could not post Wrapped now', { guild: guild.name, err }); return show(noteBad('Discord refused the message.')); }
    done('Wrapped posted now', `#${channel.name}`);
    return show(noteGood(`Posted in ${channel}.`));
  }
  if (action === 'erase') return respond(interaction, viewErase(guild));
  if (action === 'erase_yes') {
    const n = activity.erase(guild.id);
    done('Wrapped counts erased', `${n} rows`);
    return show(noteGood(`Erased ${n.toLocaleString('en-GB')} count rows.`));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
