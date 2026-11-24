/**
 * /setup page for the Security Check Point (see checkpoint.js).
 *
 * One screen: choose the channel (or let the bot create it), choose what happens to anyone who posts there,
 * choose where it is logged. A second screen holds the extra options.
 *
 * customIds: setup:checkpoint[:<action>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
} = require('discord.js');

const kit = require('./setupKit');
const cp = require('./checkpoint');
const { getLogChannel } = require('./guildConfig');
const { audit } = require('./diagnostics');
const { log } = require('./logger');
const { duration } = require('./duration');

const { BLUE, GREEN, AMBER, chan, role, noteBad, noteGood, backButton, channelSelect, respond } = kit;

const PAGES = ['checkpoint'];
const owns = (page) => PAGES.includes(page);

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

const effectiveLog = (guild, s) => s.logChannelId || getLogChannel(guild.id, 'modlog');

function viewCheckpoint(guild, user, note) {
  const s = cp.settings(guild.id);
  const channelOk = !!(s.channelId && guild.channels.cache.has(s.channelId));
  const problems = s.enabled || channelOk ? cp.diagnose(guild) : [];
  const state = !channelOk ? '⚪ Not set up yet' : s.enabled ? (problems.length ? '🟠 On, but needs attention' : '🟢 On and working') : '⚪ Off';

  const embed = new EmbedBuilder().setColor(!channelOk ? BLUE : s.enabled ? (problems.length ? AMBER : GREEN) : BLUE)
    .setTitle('Security Check Point')
    .setDescription([note,
      'A trap channel for spam bots and hacked accounts. They post in every channel they can see, so one of those posts lands here, and the member is dealt with automatically. Staff are never actioned.',
      '',
      !channelOk ? '**Quick start:** press **Create the channel for me**. That is all you need to do. Everything below is optional.' : null,
    ].filter(v => v != null).join('\n'))
    .addFields(
      { name: 'Status', value: state, inline: true },
      { name: 'Caught so far', value: String(s.caught), inline: true },
      { name: '​', value: '​', inline: true },
      { name: 'Channel', value: chan(s.channelId), inline: true },
      { name: 'When someone posts there', value: `${cp.ACTIONS[s.action].label}${s.action === 'timeout' ? ` for ${duration(cp.TIMEOUTS[s.timeout])}` : ''}`, inline: true },
      { name: 'Logged in', value: effectiveLog(guild, s) ? `${chan(effectiveLog(guild, s))}${s.logChannelId ? '' : ' *(your Moderation log)*'}` : '*nowhere yet*', inline: true },
    );
  if (problems.length) embed.addFields({ name: 'Needs attention', value: problems.map(p => `• ${p}`).join('\n').slice(0, 1000) });

  const actionMenu = new StringSelectMenuBuilder().setCustomId('setup:checkpoint:action').setPlaceholder('What happens to someone who posts there?')
    .addOptions(Object.entries(cp.ACTIONS).map(([value, a]) => ({ label: value === 'softban' ? `${a.label} (recommended)` : a.label, value, description: a.desc, default: s.action === value })));

  return {
    embeds: [embed],
    components: [
      channelSelect('setup:checkpoint:channel', 'Or use a channel you already have…', s.channelId),
      new ActionRowBuilder().addComponents(actionMenu),
      channelSelect('setup:checkpoint:log', 'Where should catches be logged?', s.logChannelId),
      new ActionRowBuilder().addComponents(
        button('setup:checkpoint:create', channelOk ? 'Create a new channel' : 'Create the channel for me', channelOk ? ButtonStyle.Secondary : ButtonStyle.Success),
        button('setup:checkpoint:toggle', s.enabled ? 'Turn off' : 'Turn on', s.enabled ? ButtonStyle.Danger : ButtonStyle.Success, !channelOk),
        button('setup:checkpoint:test', 'Test it', ButtonStyle.Primary, !channelOk),
        button('setup:checkpoint:more', 'More options')),
      new ActionRowBuilder().addComponents(backButton('home', 'Back to setup')),
    ],
  };
}

function viewMore(guild, user, note) {
  const s = cp.settings(guild.id);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Security Check Point · more options').setDescription([note,
    `**Never actioned:** server owner, anyone with a staff permission (Manage Server, Manage Messages, Kick, Ban, Timeout) and ${s.exemptRoleIds.length ? s.exemptRoleIds.map(role).join(', ') : 'no extra roles'}.`,
    `**Message to the member:** ${s.dm ? 'on, they get a short DM explaining why and how to rejoin' : 'off'}`,
    '',
    `**Timeout length** applies when the action is Timeout. **Delete messages from the last** applies to Softban and Ban.`,
  ].filter(Boolean).join('\n'));

  const exempt = new RoleSelectMenuBuilder().setCustomId('setup:checkpoint:exempt').setPlaceholder('Roles that are never actioned (optional)').setMinValues(0).setMaxValues(10);
  if (s.exemptRoleIds.length) exempt.setDefaultRoles(...s.exemptRoleIds.filter(id => guild.roles.cache.has(id)));
  const pick = (id, placeholder, map, current, label) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .addOptions(Object.entries(map).map(([value, ms]) => ({ label: label(ms), value, default: current === value })));

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(exempt),
      new ActionRowBuilder().addComponents(pick('setup:checkpoint:timeout', 'Timeout length', cp.TIMEOUTS, s.timeout, ms => `Timeout for ${duration(ms)}`)),
      new ActionRowBuilder().addComponents(pick('setup:checkpoint:window', 'Delete messages from the last…', cp.DELETE_WINDOWS, s.deleteWindow, ms => `Delete messages from the last ${duration(ms)}`)),
      new ActionRowBuilder().addComponents(
        button('setup:checkpoint:dm', s.dm ? 'Message to member: on' : 'Message to member: off', s.dm ? ButtonStyle.Success : ButtonStyle.Secondary),
        backButton('checkpoint', 'Back')),
    ],
  };
}

const VIEWS = { checkpoint: (guild, user, note) => viewCheckpoint(guild, user, note) };

/** Keep the warning in the channel in step with the chosen action. */
async function refreshWarning(guild, s) {
  const channel = s.channelId && guild.channels.cache.get(s.channelId);
  if (!channel?.isTextBased()) return s;
  try { return { ...s, messageId: await cp.postWarning(guild, channel, s) }; }
  catch (err) { log('WARN', 'Security Check Point: could not update the warning message', { guild: guild.name, err }); return s; }
}

async function handle(interaction, { guild, by, action }) {
  const show = (note) => respond(interaction, viewCheckpoint(guild, by, note));
  const more = (note) => respond(interaction, viewMore(guild, by, note));
  let s = cp.settings(guild.id);
  const changed = (what, details) => audit({ action: `Setup: Security Check Point ${what}`, actor: by, guild, details });

  if (!action) return show();
  if (action === 'more') return more();

  if (action === 'create') {
    await interaction.deferUpdate();
    if (!guild.members.me.permissions.has('ManageChannels')) return show(noteBad('I need the **Manage Channels** permission to create the channel. Give me that permission, or choose a channel you already have.'));
    try {
      const channel = await cp.createChannel(guild, by);
      s = { ...s, channelId: channel.id, messageId: null, enabled: true };
      s = await refreshWarning(guild, s);
      cp.save(guild.id, s);
      changed('channel created', `#${channel.name}`);
      return show(noteGood(`Created ${channel} and turned the Security Check Point **on**. ${effectiveLog(guild, s) ? '' : 'Choose a log channel below so you can see who it catches.'}`));
    } catch (err) {
      log('WARN', 'Security Check Point: could not create the channel', { guild: guild.name, err });
      return show(noteBad(`Discord would not let me create the channel: ${err.message}`));
    }
  }

  if (action === 'channel') {
    await interaction.deferUpdate();
    const channel = interaction.channels.first();
    const missing = kit.missingIn(channel, guild, ['ViewChannel', 'SendMessages', 'ManageMessages']);
    if (missing.length) return show(noteBad(`I can't use ${channel}: missing **${missing.join(', ')}** there.`));
    s = { ...s, channelId: channel.id, messageId: null };
    s = await refreshWarning(guild, s);
    cp.save(guild.id, s);
    changed('channel set', `#${channel.name}`);
    return show(noteGood(`Using ${channel}. I posted the warning message in it.${s.enabled ? '' : ' Press **Turn on** when you are ready.'}`));
  }

  if (action === 'log') {
    await interaction.deferUpdate();
    const channel = interaction.channels.first();
    const missing = kit.missingIn(channel, guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    cp.save(guild.id, { ...s, logChannelId: channel.id });
    changed('log channel set', `#${channel.name}`);
    return show(noteGood(`Catches will be logged in ${channel}.`));
  }

  if (action === 'action') {
    await interaction.deferUpdate();
    s = { ...s, action: interaction.values[0] };
    s = await refreshWarning(guild, s);
    cp.save(guild.id, s);
    changed('action changed', s.action);
    const need = cp.ACTIONS[s.action].needs;
    const lacking = !guild.members.me.permissions.has(need);
    return show(lacking ? noteBad(`Saved, but ${cp.ACTIONS[s.action].label} needs the **${need.replace(/([A-Z])/g, ' $1').trim()}** permission, which I don't have.`) : noteGood(`Anyone who posts there will now be **${cp.actionText(s)}**.`));
  }

  if (action === 'toggle') {
    await interaction.deferUpdate();
    if (!s.channelId) return show(noteBad('Choose or create the channel first.'));
    s = { ...s, enabled: !s.enabled };
    if (s.enabled) s = await refreshWarning(guild, s);
    cp.save(guild.id, s);
    changed(s.enabled ? 'turned on' : 'turned off');
    return show(noteGood(s.enabled ? 'The Security Check Point is **on**.' : 'The Security Check Point is **off**. The channel is still there.'));
  }

  if (action === 'test') {
    await interaction.deferUpdate();
    const problems = cp.diagnose(guild);
    let sent = false;
    try { sent = await cp.sendTest(guild, by); } catch (err) { log('WARN', 'Security Check Point test failed', { err }); }
    if (problems.length) return show(noteBad(`${sent ? 'Sent a sample log entry, but' : 'Not ready:'}\n${problems.map(p => `• ${p}`).join('\n')}`));
    return show(noteGood(sent ? 'Everything is in place. I sent a sample entry to the log channel. Nobody was actioned.' : 'Everything works, but there is no log channel yet, so nothing was sent. Choose one below.'));
  }

  // More options
  if (action === 'exempt') {
    await interaction.deferUpdate();
    cp.save(guild.id, { ...s, exemptRoleIds: [...interaction.roles.keys()] });
    changed('exempt roles', [...interaction.roles.values()].map(r => r.name).join(', ') || 'none');
    return more(noteGood('Saved.'));
  }
  if (action === 'timeout' || action === 'window') {
    await interaction.deferUpdate();
    s = { ...s, [action === 'timeout' ? 'timeout' : 'deleteWindow']: interaction.values[0] };
    s = await refreshWarning(guild, s);
    cp.save(guild.id, s);
    changed(action === 'timeout' ? 'timeout length' : 'delete window', interaction.values[0]);
    return more(noteGood('Saved.'));
  }
  if (action === 'dm') {
    await interaction.deferUpdate();
    cp.save(guild.id, { ...s, dm: !s.dm });
    changed('message to member', !s.dm ? 'on' : 'off');
    return more(noteGood(!s.dm ? 'Members will get a short message explaining what happened.' : 'Members will not be messaged.'));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
