/**
 * /setup pages for Raid protection (src/raid.js) and AutoMod (src/automod.js).
 *
 * Raid protection   setup:raid[:<action>[:<arg>]]      main screen, "more options" screen
 * AutoMod           setup:automod[:<action>[:<arg>]]   filter list, one filter, general, strikes, Discord's own rules
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const kit = require('./setupKit');
const raid = require('./raid');
const automod = require('./automod');
const { audit } = require('./diagnostics');

const { BLUE, GREEN, AMBER, RED, chan, role, onOff, noteBad, noteGood, backButton, channelSelect, respond, missingIn } = kit;

const PAGES = ['raid', 'automod'];
const owns = (page) => PAGES.includes(page);

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const select = (id, placeholder, options) => row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options));
const toggle = (id, label, on, disabled = false) => button(id, `${label}: ${onOff(on)}`, on ? ButtonStyle.Success : ButtonStyle.Secondary, disabled);
const lines = (text) => String(text || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean).slice(0, 60);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ═════════════════════════════════════════════════════════════════════════════
// Raid protection
// ═════════════════════════════════════════════════════════════════════════════

function viewRaid(guild, user, note) {
  const s = raid.settings(guild.id);
  const active = raid.isActive(s);
  const problems = raid.diagnose(guild);
  const colour = active ? RED : problems.length ? AMBER : s.enabled ? GREEN : BLUE;
  const embed = new EmbedBuilder().setColor(colour).setTitle('Raid protection').setDescription([note,
    'Protects the server when a lot of new accounts arrive at once. You choose what counts as a raid and what happens. Staff and everyone already in the server are never affected.',
    !s.enabled && !s.gateEnabled ? '\n**Quick start:** press **Detection** to turn it on. The defaults are sensible for most servers.' : null,
  ].filter(v => v != null).join('\n'))
    .addFields(
      { name: 'Raid mode', value: active ? `🔴 **ON**${s.until ? `, ends <t:${Math.floor(s.until / 1000)}:R>` : ', until staff end it'}` : '⚪ Off', inline: true },
      { name: 'Detection', value: s.enabled ? `🟢 ${s.joins} joins in ${s.seconds}s` : '⚪ Off', inline: true },
      { name: 'Account age gate', value: s.gateEnabled ? `🟢 under ${plural(s.gateDays, 'day')}: ${raid.ACTIONS[s.gateAction].label.toLowerCase()}` : '⚪ Off', inline: true },
      { name: 'When a raid is detected', value: s.response === 'mode' ? `Start raid mode: ${raid.describeMode(s)}` : 'Alert staff only', inline: false },
      { name: 'Alerts go to', value: `${s.alertChannelId ? chan(s.alertChannelId) : '*your Moderation log*'}${s.pingRoleId ? ` · pings ${role(s.pingRoleId)}` : ''}`, inline: false },
      { name: 'So far', value: `${plural(s.raids, 'raid')} handled · ${plural(s.caught, 'member')} actioned`, inline: false },
    );
  if (problems.length) embed.addFields({ name: 'Needs attention', value: problems.map(p => `• ${p}`).join('\n').slice(0, 1000) });

  return {
    embeds: [embed],
    components: [
      select('setup:raid:response', 'What should happen when a raid is detected?', Object.entries(raid.RESPONSES).map(([value, r]) => ({ label: r.label, value, description: r.desc, default: s.response === value }))),
      select('setup:raid:target', 'Who does raid mode catch?', Object.entries(raid.TARGETS).map(([value, t]) => ({ label: t.label, value, description: t.desc, default: s.modeTarget === value }))),
      select('setup:raid:action', 'What happens to them?', Object.entries(raid.ACTIONS).map(([value, a]) => ({ label: a.label, value, description: a.desc, default: s.modeAction === value }))),
      row(toggle('setup:raid:detect', 'Detection', s.enabled), button('setup:raid:mode', active ? 'End raid mode now' : 'Start raid mode now', active ? ButtonStyle.Success : ButtonStyle.Danger),
        button('setup:raid:nums', 'Edit numbers', ButtonStyle.Primary), toggle('setup:raid:gate', 'Age gate', s.gateEnabled)),
      row(button('setup:raid:more', 'More options'), backButton('home', 'Back to setup')),
    ],
  };
}

function viewRaidMore(guild, user, note) {
  const s = raid.settings(guild.id);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Raid protection · more options').setDescription([note,
    `**Pause invites during raid mode:** ${onOff(s.pauseInvites)}. Nobody new can join with an invite link until raid mode ends (needs Manage Server). Invites are only turned back on if raid mode paused them.`,
    `**Deal with recent joiners:** ${onOff(s.sweep)}. When a raid is detected, also action the people who just arrived.`,
    `**Message to the member:** ${onOff(s.dm)}. They are told why, before they are removed.`,
    `**Raid mode lasts:** ${raid.MODE_LENGTHS[s.modeMinutes]}`,
    `**Age gate action:** ${raid.ACTIONS[s.gateAction].label}`,
  ].join('\n'));
  const pingRole = new RoleSelectMenuBuilder().setCustomId('setup:raid:ping').setPlaceholder('Role to ping when a raid starts (optional)').setMinValues(0).setMaxValues(1);
  if (s.pingRoleId && guild.roles.cache.has(s.pingRoleId)) pingRole.setDefaultRoles(s.pingRoleId);
  return {
    embeds: [embed],
    components: [
      channelSelect('setup:raid:alerts', 'Where should raid alerts go? (default: Moderation log)', s.alertChannelId),
      row(pingRole),
      select('setup:raid:length', 'How long does raid mode last?', Object.entries(raid.MODE_LENGTHS).map(([value, label]) => ({ label, value, default: String(s.modeMinutes) === value }))),
      select('setup:raid:gateaction', 'What happens to accounts that are too new?', Object.entries(raid.ACTIONS).map(([value, a]) => ({ label: a.label, value, description: a.desc, default: s.gateAction === value }))),
      row(toggle('setup:raid:pause', 'Pause invites', s.pauseInvites), toggle('setup:raid:sweep', 'Recent joiners', s.sweep), toggle('setup:raid:dm', 'Message to member', s.dm), backButton('raid', 'Back')),
    ],
  };
}

function numbersModal(guild) {
  const s = raid.settings(guild.id);
  const input = (id, label, value, placeholder) => row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setValue(String(value)).setPlaceholder(placeholder));
  return new ModalBuilder().setCustomId('setup:raid:numsm').setTitle('Raid protection numbers').addComponents(
    input('joins', 'A raid is this many joins (2 to 100)', s.joins, '8'),
    input('seconds', '…within this many seconds (5 to 600)', s.seconds, '30'),
    input('young', 'A new account is under (days, 1 to 365)', s.modeYoungDays, '7'),
    input('gate', 'Age gate: refuse under (days, 1 to 365)', s.gateDays, '3'),
  );
}

async function handleRaid(interaction, { guild, by, action }) {
  const show = (note) => respond(interaction, viewRaid(guild, by, note));
  const more = (note) => respond(interaction, viewRaidMore(guild, by, note));
  const done = (what, details) => audit({ action: `Setup: Raid protection, ${what}`, actor: by, guild, details });
  const s = raid.settings(guild.id);
  const put = (obj) => raid.patch(guild.id, obj);
  const flip = async (key, label, fn = show) => { await interaction.deferUpdate(); put({ [key]: !s[key] }); done(`${label} ${!s[key] ? 'on' : 'off'}`); return fn(); };

  if (!action) return show();
  if (action === 'more') return more();

  if (action === 'response') { await interaction.deferUpdate(); put({ response: interaction.values[0] }); done('response', interaction.values[0]); return show(noteGood('Saved.')); }
  if (action === 'target')   { await interaction.deferUpdate(); put({ modeTarget: interaction.values[0] }); done('raid mode target', interaction.values[0]); return show(noteGood('Saved.')); }
  if (action === 'action') {
    await interaction.deferUpdate(); put({ modeAction: interaction.values[0] }); done('raid mode action', interaction.values[0]);
    const problems = raid.diagnose(guild);
    return show(problems.length ? noteBad(`Saved, but ${problems[0]}`) : noteGood('Saved.'));
  }
  if (action === 'detect') {
    await interaction.deferUpdate(); put({ enabled: !s.enabled }); done(`detection ${!s.enabled ? 'on' : 'off'}`);
    const problems = !s.enabled ? raid.diagnose(guild) : [];
    return show(problems.length ? noteBad(`Detection is on, but ${problems[0]}`) : noteGood(!s.enabled ? `Detection is **on**. A raid is **${s.joins} joins in ${s.seconds} seconds**.` : 'Detection is **off**.'));
  }
  if (action === 'gate') {
    await interaction.deferUpdate(); put({ gateEnabled: !s.gateEnabled }); done(`age gate ${!s.gateEnabled ? 'on' : 'off'}`);
    const problems = !s.gateEnabled ? raid.diagnose(guild) : [];
    return show(problems.length ? noteBad(`The age gate is on, but ${problems[0]}`) : noteGood(!s.gateEnabled ? `Accounts under **${plural(s.gateDays, 'day')}** old are now ${raid.ACTIONS[s.gateAction].short} when they join.` : 'The age gate is **off**.'));
  }
  if (action === 'mode') {
    await interaction.deferUpdate();
    if (raid.isActive(s)) { await raid.stop(guild, by, `Ended by ${by.tag || by.username}`); done('raid mode ended'); return show(noteGood('Raid mode is **off**.')); }
    const r = await raid.start(guild, by, `Started by ${by.tag || by.username}`); done('raid mode started');
    return show(r.note ? noteBad(`Raid mode is **on**. ${r.note}`) : noteGood('Raid mode is **on**.'));
  }
  if (action === 'nums') return interaction.showModal(numbersModal(guild)), true;
  if (action === 'numsm') {
    const f = (id) => interaction.fields.getTextInputValue(id).trim();
    const nums = { joins: [f('joins'), 2, 100], seconds: [f('seconds'), 5, 600], modeYoungDays: [f('young'), 1, 365], gateDays: [f('gate'), 1, 365] };
    for (const [v, lo, hi] of Object.values(nums)) if (!/^\d+$/.test(v) || +v < lo || +v > hi) return show(noteBad(`Each number must be a whole number: joins 2 to 100, seconds 5 to 600, days 1 to 365.`));
    put(Object.fromEntries(Object.entries(nums).map(([k, [v]]) => [k, +v]))); done('numbers changed');
    return show(noteGood('Saved.'));
  }

  // More options
  if (action === 'pause') return flip('pauseInvites', 'pause invites', more);
  if (action === 'sweep') return flip('sweep', 'deal with recent joiners', more);
  if (action === 'dm')    return flip('dm', 'message to member', more);
  if (action === 'length')     { await interaction.deferUpdate(); put({ modeMinutes: +interaction.values[0] }); done('raid mode length', interaction.values[0]); return more(noteGood('Saved.')); }
  if (action === 'gateaction') { await interaction.deferUpdate(); put({ gateAction: interaction.values[0] }); done('age gate action', interaction.values[0]); return more(noteGood('Saved.')); }
  if (action === 'ping') { await interaction.deferUpdate(); put({ pingRoleId: interaction.roles.first()?.id || null }); done('ping role'); return more(noteGood('Saved.')); }
  if (action === 'alerts') {
    await interaction.deferUpdate();
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (missing.length) return more(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    put({ alertChannelId: channel.id }); done('alert channel', `#${channel.name}`);
    return more(noteGood(`Raid alerts go to ${channel}.`));
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// AutoMod
// ═════════════════════════════════════════════════════════════════════════════

function viewAutomod(guild, user, note) {
  const s = automod.settings(guild.id);
  const problems = automod.diagnose(guild);
  const anyOn = Object.values(s.filters).some(f => f.on);
  const embed = new EmbedBuilder().setColor(s.enabled ? (problems.length ? AMBER : GREEN) : BLUE).setTitle('AutoMod').setDescription([note,
    'Filters that check every message and deal with the ones that break your rules. Staff, exempt roles and exempt channels are never touched. Pick a filter below to switch it on and set how strict it is.',
    !s.enabled ? '\n**Quick start:** turn on a filter or two, then press **AutoMod: off** to switch AutoMod on.' : s.enabled && !anyOn ? '\nAutoMod is on, but no filter is on yet. Pick one below.' : null,
  ].filter(v => v != null).join('\n'))
    .addFields(
      { name: 'Status', value: s.enabled ? '🟢 On' : '⚪ Off', inline: true },
      { name: 'Messages dealt with', value: String(s.caught), inline: true },
      { name: 'Logged in', value: s.logChannelId ? chan(s.logChannelId) : '*your Moderation log*', inline: true },
      { name: 'Filters', value: Object.entries(automod.FILTERS).map(([k, f]) => `${s.filters[k].on ? '🟢' : '⚪'} ${f.emoji} **${f.label}**: ${automod.filterSummary(s.filters[k], k)}`).join('\n') },
      { name: 'Strikes', value: s.strikes ? `${s.strikes} strikes in ${plural(s.strikeMinutes, 'minute')} means a timeout of ${automod.TIMEOUTS[s.strikeTimeout]}` : 'Off', inline: false },
    );
  if (problems.length) embed.addFields({ name: 'Needs attention', value: problems.map(p => `• ${p}`).join('\n').slice(0, 1000) });
  return {
    embeds: [embed],
    components: [
      select('setup:automod:pick', 'Choose a filter to set up…', Object.entries(automod.FILTERS).map(([value, f]) => ({ label: f.label, value, emoji: f.emoji, description: `${s.filters[value].on ? 'On' : 'Off'} · ${f.desc}`.slice(0, 100) }))),
      row(toggle('setup:automod:toggle', 'AutoMod', s.enabled, false), button('setup:automod:gen', 'General settings'), button('setup:automod:strk', 'Strikes & timeouts'), button('setup:automod:native', "Discord's own AutoMod", ButtonStyle.Primary)),
      row(backButton('home', 'Back to setup')),
    ],
  };
}

function viewFilter(guild, key, note) {
  const s = automod.settings(guild.id), meta = automod.FILTERS[key], f = s.filters[key];
  const detail = meta.fields.map(fl => fl.list ? `**${fl.label.split(' (')[0]}:** ${f[fl.id].length ? f[fl.id].map(v => `\`${v}\``).join(', ').slice(0, 500) : '*none*'}` : `**${fl.label}:** ${f[fl.id]}`);
  const embed = new EmbedBuilder().setColor(f.on ? GREEN : BLUE).setTitle(`${meta.emoji} ${meta.label}`).setDescription([note, meta.desc, '',
    `**Status:** ${f.on ? '🟢 On' : '⚪ Off'}`, `**When someone breaks it:** ${automod.RESPONSES[f.response].label}`, ...detail,
    '', `Every message removed counts as a strike. ${s.strikes ? `${s.strikes} strikes in ${plural(s.strikeMinutes, 'minute')} means a timeout.` : 'Strikes are off.'}`].filter(v => v != null).join('\n'));
  return {
    embeds: [embed],
    components: [
      select(`setup:automod:resp:${key}`, 'What happens to the message and the member?', Object.entries(automod.RESPONSES).map(([value, r]) => ({ label: value === 'timeout' ? `${r.label} (${automod.TIMEOUTS[s.timeout]})` : r.label, value, description: r.desc, default: f.response === value }))),
      row(toggle(`setup:automod:on:${key}`, meta.label, f.on, false), button(`setup:automod:edit:${key}`, meta.fields.length ? 'Edit limits & lists' : 'Nothing to edit', ButtonStyle.Primary, !meta.fields.length), backButton('automod', 'Back')),
    ],
  };
}

function filterModal(guild, key) {
  const meta = automod.FILTERS[key], f = automod.settings(guild.id).filters[key];
  return new ModalBuilder().setCustomId(`setup:automod:editm:${key}`).setTitle(meta.label).addComponents(meta.fields.map(fl => row(
    new TextInputBuilder().setCustomId(fl.id).setLabel(fl.label.slice(0, 45)).setStyle(fl.list ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(!fl.list)
      .setMaxLength(fl.list ? 1500 : 4).setPlaceholder(fl.list ? fl.example : String(fl.def)).setValue((fl.list ? f[fl.id].join('\n') : String(f[fl.id])).slice(0, fl.list ? 1500 : 4)))));
}

const multiChannels = (id, placeholder, current) => {
  const m = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum).setMinValues(0).setMaxValues(25);
  if (current.length) m.setDefaultChannels(...current.slice(0, 25));
  return row(m);
};

function viewGeneral(guild, note) {
  const s = automod.settings(guild.id);
  const roles = s.exemptRoleIds.filter(id => guild.roles.cache.has(id)), chans = s.exemptChannelIds.filter(id => guild.channels.cache.has(id));
  const exemptRoles = new RoleSelectMenuBuilder().setCustomId('setup:automod:xroles').setPlaceholder('Roles AutoMod ignores (optional)').setMinValues(0).setMaxValues(10);
  if (roles.length) exemptRoles.setDefaultRoles(...roles);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('AutoMod · general').setDescription([note,
    `**Log channel:** ${s.logChannelId ? chan(s.logChannelId) : '*your Moderation log*'}. Every message removed is logged here with what was said.`,
    `**Ignored roles:** ${roles.length ? roles.map(role).join(' ') : '*none*'}`, `**Ignored channels:** ${chans.length ? chans.map(chan).join(' ') : '*none*'}`,
    `**Notice in the channel:** ${onOff(s.notice)}. A short message that disappears after 8 seconds, so everyone knows what the rule is.`,
    'The server owner and anyone with a staff permission are always ignored.'].join('\n'));
  return {
    embeds: [embed],
    components: [channelSelect('setup:automod:log', 'Where should AutoMod log?', s.logChannelId), row(exemptRoles), multiChannels('setup:automod:xchans', 'Channels AutoMod ignores (optional)', chans),
      row(toggle('setup:automod:notice', 'Notice in channel', s.notice), backButton('automod', 'Back'))],
  };
}

function viewStrikes(guild, note) {
  const s = automod.settings(guild.id);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('AutoMod · strikes & timeouts').setDescription([note,
    `**Strikes:** ${s.strikes ? `${s.strikes} strikes within ${plural(s.strikeMinutes, 'minute')} and the member is timed out for **${automod.TIMEOUTS[s.strikeTimeout]}**` : 'off'}. Every message AutoMod removes is one strike. Strikes are forgotten after the time window.`,
    `**Timeout for filters set to "time out":** ${automod.TIMEOUTS[s.timeout]}`,
  ].join('\n'));
  const opts = (cur) => Object.entries(automod.TIMEOUTS).map(([value, label]) => ({ label, value, default: String(cur) === value }));
  return { embeds: [embed], components: [select('setup:automod:tmo', 'Timeout for filters set to "time out"', opts(s.timeout)), select('setup:automod:stmo', 'Timeout when strikes add up', opts(s.strikeTimeout)),
    row(button('setup:automod:strkedit', 'Edit strike rules', ButtonStyle.Primary), backButton('automod', 'Back'))] };
}

async function viewNative(guild, note) {
  const status = await automod.nativeStatus(guild);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle("Discord's own AutoMod").setDescription([note,
    "Discord has AutoMod built in. It blocks a message **before it is ever posted**, which the bot's own filters can't do. Press a button to add a rule. It is made for you with sensible settings, and alerts go to your AutoMod log. You can fine-tune any rule later in Server Settings > AutoMod.",
    '', ...Object.entries(automod.NATIVE).map(([k, v]) => `${status ? (status[k] ? '🟢' : '⚪') : '❔'} **${v.label}**`),
    status ? null : '\nI could not read your existing rules. I need the **Manage Server** permission for this page.'].filter(v => v != null).join('\n'));
  const btn = (k, label) => button(`setup:automod:nat:${k}`, `${status?.[k] ? 'Replace' : 'Add'}: ${label}`, status?.[k] ? ButtonStyle.Secondary : ButtonStyle.Primary);
  return { embeds: [embed], components: [row(btn('keywords', 'Bad language'), btn('mentions', 'Mention spam')), row(btn('spam', 'Spam'), btn('scam', 'Scam lures')), row(backButton('automod', 'Back'))] };
}

const strikeModal = (guild) => {
  const s = automod.settings(guild.id);
  const input = (id, label, value, ph) => row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(value)).setPlaceholder(ph));
  return new ModalBuilder().setCustomId('setup:automod:strkm').setTitle('Strike rules').addComponents(input('strikes', 'Strikes before a timeout (0 = off, up to 20)', s.strikes, '3'), input('minutes', 'Within how many minutes (1 to 120)', s.strikeMinutes, '10'));
};

const VIEWS = { raid: (guild, user, note) => viewRaid(guild, user, note), automod: (guild, user, note) => viewAutomod(guild, user, note) };

async function handleAutomod(interaction, { guild, by, action, arg }) {
  const show = (note) => respond(interaction, viewAutomod(guild, by, note));
  const filter = (key, note) => respond(interaction, viewFilter(guild, key, note));
  const general = (note) => respond(interaction, viewGeneral(guild, note));
  const strikes = (note) => respond(interaction, viewStrikes(guild, note));
  const native = async (note) => respond(interaction, await viewNative(guild, note));
  const done = (what, details) => audit({ action: `Setup: AutoMod, ${what}`, actor: by, guild, details });
  const s = automod.settings(guild.id);
  const key = automod.FILTERS[arg] ? arg : null;

  if (!action) return show();
  if (action === 'gen') return general();
  if (action === 'strk') return strikes();
  if (action === 'native') { await interaction.deferUpdate(); return native(); }
  if (action === 'pick') { await interaction.deferUpdate(); return filter(interaction.values[0]); }
  if (action === 'f' && key) return filter(key);

  if (action === 'toggle') {
    await interaction.deferUpdate(); automod.patch(guild.id, { enabled: !s.enabled }); done(`AutoMod ${!s.enabled ? 'on' : 'off'}`);
    const problems = !s.enabled ? automod.diagnose(guild) : [];
    return show(problems.length ? noteBad(`AutoMod is on, but ${problems[0]}`) : noteGood(`AutoMod is **${!s.enabled ? 'on' : 'off'}**.`));
  }

  if (key && action === 'on') {
    await interaction.deferUpdate(); const now = !s.filters[key].on; automod.patchFilter(guild.id, key, { on: now }); done(`${key} filter ${now ? 'on' : 'off'}`);
    return filter(key, noteGood(now ? `${automod.FILTERS[key].label} is **on**.${s.enabled ? '' : ' AutoMod itself is still off: turn it on from the main AutoMod page.'}` : `${automod.FILTERS[key].label} is **off**.`));
  }
  if (key && action === 'resp') { await interaction.deferUpdate(); automod.patchFilter(guild.id, key, { response: interaction.values[0] }); done(`${key} response`, interaction.values[0]); return filter(key, noteGood('Saved.')); }
  if (key && action === 'edit') return interaction.showModal(filterModal(guild, key)), true;
  if (key && action === 'editm') {
    const out = {};
    for (const fl of automod.FILTERS[key].fields) {
      const raw = interaction.fields.getTextInputValue(fl.id).trim();
      if (fl.list) out[fl.id] = [...new Set(lines(raw).map(v => key === 'words' ? v.toLowerCase() : v.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')))];
      else { if (!/^\d+$/.test(raw) || +raw < fl.min || +raw > fl.max) return filter(key, noteBad(`**${fl.label}** must be a whole number from ${fl.min} to ${fl.max}.`)); out[fl.id] = +raw; }
    }
    automod.patchFilter(guild.id, key, out); done(`${key} limits`);
    return filter(key, noteGood('Saved.'));
  }

  if (action === 'log') {
    await interaction.deferUpdate(); const channel = interaction.channels.first();
    const missing = missingIn(channel, guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (missing.length) return general(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    automod.patch(guild.id, { logChannelId: channel.id }); done('log channel', `#${channel.name}`);
    return general(noteGood(`AutoMod logs to ${channel}.`));
  }
  if (action === 'xroles') { await interaction.deferUpdate(); automod.patch(guild.id, { exemptRoleIds: [...interaction.roles.keys()] }); done('ignored roles'); return general(noteGood('Saved.')); }
  if (action === 'xchans') { await interaction.deferUpdate(); automod.patch(guild.id, { exemptChannelIds: [...interaction.channels.keys()] }); done('ignored channels'); return general(noteGood('Saved.')); }
  if (action === 'notice') { await interaction.deferUpdate(); automod.patch(guild.id, { notice: !s.notice }); done(`notice ${!s.notice ? 'on' : 'off'}`); return general(); }

  if (action === 'tmo' || action === 'stmo') { await interaction.deferUpdate(); automod.patch(guild.id, { [action === 'tmo' ? 'timeout' : 'strikeTimeout']: +interaction.values[0] }); done(action === 'tmo' ? 'timeout length' : 'strike timeout length', interaction.values[0]); return strikes(noteGood('Saved.')); }
  if (action === 'strkedit') return interaction.showModal(strikeModal(guild)), true;
  if (action === 'strkm') {
    const n = interaction.fields.getTextInputValue('strikes').trim(), m = interaction.fields.getTextInputValue('minutes').trim();
    if (!/^\d+$/.test(n) || +n > 20 || !/^\d+$/.test(m) || +m < 1 || +m > 120) return strikes(noteBad('Strikes must be 0 to 20, and minutes 1 to 120.'));
    automod.patch(guild.id, { strikes: +n, strikeMinutes: +m }); done('strike rules', `${n} in ${m} min`);
    return strikes(noteGood('Saved.'));
  }

  if (action === 'nat' && automod.NATIVE[arg]) {
    await interaction.deferUpdate();
    const r = await automod.createNative(guild, arg); done(`Discord rule ${arg}`, r.ok ? 'added' : 'failed');
    return native(r.ok ? noteGood(r.text) : noteBad(r.text));
  }
  return false;
}

async function handle(interaction, ctx) {
  if (ctx.page === 'raid') return handleRaid(interaction, ctx);
  return handleAutomod(interaction, ctx);
}

module.exports = { PAGES, owns, handle, VIEWS };
