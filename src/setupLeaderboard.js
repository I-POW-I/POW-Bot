/**
 * /setup page for the voice leaderboard and its role rewards.
 *
 * The leaderboard itself (panel button and /leaderboard) is always available.
 * This page only controls the optional rewards: pick a ladder, then either let the bot create the roles
 * or choose existing ones.
 *
 * customIds: setup:leaderboard[:<action>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');

const kit = require('./setupKit');
const lb = require('./leaderboard');
const { audit } = require('./diagnostics');

const { BLUE, role, chan, onOff, noteBad, noteGood, backButton, roleSelect, channelSelect, missingIn, respond } = kit;

const PAGES = ['leaderboard'];
const owns = (page) => PAGES.includes(page);

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

const tierLine = (t, s) => {
  const linked = t.roleId && role(t.roleId) !== '*not set*' ? role(t.roleId) : null;
  return `${t.hours}h: ${linked || (s.autoRoles ? `*"${t.name}" will be created*` : '*choose a role*')}`;
};

function viewLeaderboard(guild, user, note) {
  const s = lb.settings(guild.id);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Voice leaderboard and rewards').setDescription([note,
    'The leaderboard is always available from the voice panel and `/leaderboard`. Time in the AFK channel is not counted.',
    '',
    `**Scheduled post:** ${s.post.frequency === 'off' ? 'off' : `${lb.FREQUENCIES[s.post.frequency].label.toLowerCase()} in ${chan(s.post.channelId)}`}`,
    `**Ignore time alone:** ${s.ignoreAlone ? 'on, time spent in a call with nobody else does not count' : 'off, every minute in a call counts'}`,
    `**Yearly reset:** ${s.yearlyReset ? 'on, stats start fresh every 1 January' : 'off, stats are kept until the bot leaves the server'}`,
    `**Rewards:** ${onOff(s.rewards)}`,
    `**Roles:** ${s.autoRoles ? 'the bot creates them' : 'you choose them'}`,
    s.tiers.length ? `\n**Ladder**\n${s.tiers.map(t => tierLine(t, s)).join('\n')}` : '\nNo ladder yet. Choose one below.',
    '',
    'Members hold the role for the highest tier they have reached. Lower tier roles are removed as they move up.']
    .filter(v => v !== null && v !== undefined && v !== false).join('\n'));

  const ladderSelect = new StringSelectMenuBuilder().setCustomId('setup:leaderboard:ladder').setPlaceholder('Choose a ladder')
    .addOptions([
      ...Object.entries(lb.PRESETS).map(([value, p]) => ({ label: p.label, value, description: `${p.hours.join(', ')} hours` })),
      { label: 'Custom ladder', value: 'custom', description: 'Set your own hours and role names' },
    ]);

  const components = [
    new ActionRowBuilder().addComponents(ladderSelect),
    new ActionRowBuilder().addComponents(
      button('setup:leaderboard:rewards', `Rewards: ${onOff(s.rewards)}`, s.rewards ? ButtonStyle.Success : ButtonStyle.Secondary),
      button('setup:leaderboard:auto', `Roles: ${s.autoRoles ? 'bot creates them' : 'I choose them'}`),
      button('setup:leaderboard:apply', 'Apply to members now', ButtonStyle.Primary, !s.rewards),
      button('setup:leaderboard:post', 'Scheduled post')),
    new ActionRowBuilder().addComponents(
      button('setup:leaderboard:yearly', `Yearly reset: ${onOff(s.yearlyReset)}`, s.yearlyReset ? ButtonStyle.Success : ButtonStyle.Secondary),
      button('setup:leaderboard:alone', `Ignore time alone: ${onOff(s.ignoreAlone)}`, s.ignoreAlone ? ButtonStyle.Success : ButtonStyle.Secondary)),
  ];
  if (!s.autoRoles && s.tiers.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:leaderboard:tierpick').setPlaceholder('Choose the role for a tier')
      .addOptions(s.tiers.map((t, i) => ({ label: `${t.hours} hours`, value: String(i), description: t.roleId && guild.roles.cache.get(t.roleId) ? `Currently ${guild.roles.cache.get(t.roleId).name}` : 'No role chosen' })))));
  }
  components.push(new ActionRowBuilder().addComponents(backButton()));
  return { embeds: [embed], components };
}

function viewTierRole(guild, index) {
  const s = lb.settings(guild.id), t = s.tiers[index];
  if (!t) return viewLeaderboard(guild, null, noteBad('That tier no longer exists.'));
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`Role for ${t.hours} hours`).setDescription(`Choose the role members get at **${t.hours} hours** of voice time. My highest role must be above it.`)],
    components: [roleSelect(`setup:leaderboard:tierrole:${index}`, 'Choose a role', t.roleId), new ActionRowBuilder().addComponents(backButton('leaderboard'))],
  };
}

function viewPost(guild, note) {
  const { post } = lb.settings(guild.id);
  const freq = new StringSelectMenuBuilder().setCustomId('setup:leaderboard:postfreq').setPlaceholder('How often?')
    .addOptions([
      { label: 'Off', value: 'off', default: post.frequency === 'off' },
      { label: 'Weekly', value: 'weekly', description: 'Mondays, the top 10 of the last 7 days', default: post.frequency === 'weekly' },
      { label: 'Monthly', value: 'monthly', description: 'The 1st of each month, the top 10 of the last 30 days', default: post.frequency === 'monthly' },
    ]);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Scheduled leaderboard post').setDescription([note,
      'Post the voice leaderboard automatically. Posts go out at 09:00 UTC. Turning it on starts with the next week or month, nothing is posted straight away.',
      '',
      `**Frequency:** ${post.frequency === 'off' ? 'off' : lb.FREQUENCIES[post.frequency].label.toLowerCase()}`,
      `**Channel:** ${chan(post.channelId)}`].filter(Boolean).join('\n'))],
    components: [
      new ActionRowBuilder().addComponents(freq),
      channelSelect('setup:leaderboard:postchan', 'Choose the channel', post.channelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      new ActionRowBuilder().addComponents(backButton('leaderboard')),
    ],
  };
}

const ladderModal = (guildId) => new ModalBuilder().setCustomId('setup:leaderboard:ladmodal').setTitle('Custom ladder').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tiers').setLabel('One tier per line: hours, then a role name').setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMaxLength(600).setPlaceholder('10 Regular\n50 Veteran\n200 Legend')
    .setValue(lb.settings(guildId).tiers.map(t => `${t.hours} ${t.name}`).join('\n').slice(0, 600))));

const VIEWS = { leaderboard: (guild, user, note) => viewLeaderboard(guild, user, note) };

async function handle(interaction, { guild, by, action, arg }) {
  const show = (note) => respond(interaction, viewLeaderboard(guild, by, note));
  const s = lb.settings(guild.id);

  if (!action) return show();

  if (action === 'ladder') {
    const choice = interaction.values[0];
    if (choice === 'custom') return interaction.showModal(ladderModal(guild.id));
    await interaction.deferUpdate();
    return applyLadder(guild, by, lb.presetLadder(guild.id, choice), show, `${lb.PRESETS[choice].label} ladder`);
  }
  if (action === 'ladmodal') {
    await interaction.deferUpdate();
    const parsed = lb.parseLadder(guild.id, interaction.fields.getTextInputValue('tiers'));
    if (!parsed.ok) return show(noteBad(parsed.error));
    return applyLadder(guild, by, parsed.tiers, show, 'Custom ladder');
  }
  if (action === 'auto') {
    await interaction.deferUpdate();
    s.autoRoles = !s.autoRoles;
    lb.save(guild.id, s);
    audit({ action: 'Setup: voice reward roles', actor: by, guild, details: s.autoRoles ? 'bot creates the roles' : 'owner chooses the roles' });
    if (s.autoRoles && s.rewards && s.tiers.length) {
      const res = await lb.ensureRoles(guild, s);
      return show(res.error ? noteBad(res.error) : noteGood(res.created.length ? `Created: ${res.created.join(', ')}.` : 'The bot now creates the roles.'));
    }
    return show(noteGood(s.autoRoles ? 'The bot will create the roles when you turn rewards on.' : 'Choose a role for each tier below.'));
  }
  if (action === 'alone') {
    await interaction.deferUpdate();
    s.ignoreAlone = !s.ignoreAlone; lb.save(guild.id, s);
    audit({ action: 'Setup: leaderboard ignore time alone', actor: by, guild, details: s.ignoreAlone ? 'on' : 'off' });
    return show(noteGood(s.ignoreAlone ? 'Time spent alone in a call no longer counts on the leaderboard.' : 'All time in a call counts again.'));
  }
  if (action === 'yearly') {
    if (s.yearlyReset) {
      await interaction.deferUpdate();
      s.yearlyReset = false; lb.save(guild.id, s);
      audit({ action: 'Setup: yearly voice reset', actor: by, guild, details: 'off' });
      return show(noteGood('Yearly reset is off. Stats are kept until the bot leaves the server.'));
    }
    return respond(interaction, { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Turn on the yearly reset?').setDescription(
      `On **1 January (UTC)** all voice and live stats from before the new year are deleted, so the leaderboard starts fresh.\n\n**Turning it on now deletes everything recorded before 1 January ${new Date().getUTCFullYear()}** the next time the bot checks (within a few hours). This can't be undone.`)],
      components: [new ActionRowBuilder().addComponents(button('setup:leaderboard:yearlyon', 'Turn on the yearly reset', ButtonStyle.Danger), backButton('leaderboard'))] });
  }
  if (action === 'yearlyon') {
    await interaction.deferUpdate();
    s.yearlyReset = true; lb.save(guild.id, s);
    audit({ action: 'Setup: yearly voice reset', actor: by, guild, details: 'on' });
    return show(noteGood('Yearly reset is on. Stats start fresh every 1 January.'));
  }
  if (action === 'post') return respond(interaction, viewPost(guild));
  if (action === 'postfreq') {
    const choice = interaction.values[0];
    if (choice !== 'off' && !s.post.channelId) return respond(interaction, viewPost(guild, noteBad('Choose a channel first, then pick how often.')));
    lb.setPost(guild.id, choice, null);
    audit({ action: 'Setup: scheduled leaderboard', actor: by, guild, details: choice });
    return respond(interaction, viewPost(guild, noteGood(choice === 'off' ? 'The scheduled post is off.' : `The ${choice} post is on. The first one goes out at the start of the next ${choice === 'weekly' ? 'week' : 'month'}.`)));
  }
  if (action === 'postchan') {
    const channel = interaction.channels.first();
    const missing = channel ? missingIn(channel, guild) : [];
    if (missing.length) return respond(interaction, viewPost(guild, noteBad(`I can't post in ${channel}. I need: ${missing.join(', ')}.`)));
    s.post.channelId = channel?.id || null; lb.save(guild.id, s);
    audit({ action: 'Setup: scheduled leaderboard channel', actor: by, guild, details: channel ? `#${channel.name}` : 'cleared' });
    return respond(interaction, viewPost(guild, noteGood(`Posts will go to ${channel}.`)));
  }
  if (action === 'tierpick') return respond(interaction, viewTierRole(guild, Number(interaction.values[0])));
  if (action === 'tierrole') {
    const index = Number(arg), chosen = interaction.roles.first();
    if (!s.tiers[index]) return show(noteBad('That tier no longer exists.'));
    if (chosen && !chosen.editable) return respond(interaction, { ...viewTierRole(guild, index), content: `I can't give out ${chosen.name}: my highest role must be above it. Server Settings, Roles, drag my role higher.` });
    s.tiers[index].roleId = chosen?.id || null;
    lb.save(guild.id, s);
    audit({ action: 'Setup: voice reward role', actor: by, guild, details: `${s.tiers[index].hours}h: ${chosen ? '@' + chosen.name : 'cleared'}` });
    return show(noteGood(chosen ? `${s.tiers[index].hours}h now gives ${chosen}.` : 'Role cleared.'));
  }
  if (action === 'rewards') {
    await interaction.deferUpdate();
    if (s.rewards) {
      s.rewards = false; lb.save(guild.id, s);
      audit({ action: 'Setup: voice rewards', actor: by, guild, details: 'off' });
      return show(noteGood('Rewards are off. Members keep the roles they already have.'));
    }
    if (!s.tiers.length) return show(noteBad('Choose a ladder first.'));
    if (!lb.canManageRoles(guild)) return show(noteBad('I need the **Manage Roles** permission.'));
    let created = [];
    if (s.autoRoles) {
      const res = await lb.ensureRoles(guild, s);
      if (res.error) return show(noteBad(res.error));
      created = res.created;
    }
    const problems = lb.roleProblems(guild, s);
    if (problems.length) return show(noteBad(`Rewards can't start yet:\n${problems.join('\n')}`));
    s.rewards = true; lb.save(guild.id, s);
    audit({ action: 'Setup: voice rewards', actor: by, guild, details: `on, ${s.tiers.length} tiers` });
    const result = await lb.syncAll(guild);
    return show(noteGood(`Rewards are on.${created.length ? ` Created: ${created.join(', ')}.` : ''} Checked ${result.checked} member(s), updated ${result.changed}.`));
  }
  if (action === 'apply') {
    await interaction.deferUpdate();
    const problems = lb.roleProblems(guild, s);
    if (problems.length) return show(noteBad(`Fix these first:\n${problems.join('\n')}`));
    const result = await lb.syncAll(guild);
    return show(noteGood(`Checked ${result.checked} member(s), updated ${result.changed}.`));
  }
  return false;
}

/** Save a new ladder, creating its roles when the bot manages them and rewards are on. */
async function applyLadder(guild, by, tiers, show, label) {
  const s = lb.settings(guild.id);
  const dropped = s.tiers.filter(t => t.roleId && !tiers.some(n => n.roleId === t.roleId));
  s.tiers = tiers; lb.save(guild.id, s);
  audit({ action: 'Setup: voice reward ladder', actor: by, guild, details: `${label}: ${tiers.map(t => t.hours + 'h').join(', ')}` });
  let note = `${label} saved.`;
  if (s.rewards && s.autoRoles) {
    const res = await lb.ensureRoles(guild, s);
    if (res.error) return show(noteBad(res.error));
    if (res.created.length) note += ` Created: ${res.created.join(', ')}.`;
    const result = await lb.syncAll(guild);
    note += ` Updated ${result.changed} member(s).`;
  }
  if (dropped.length) note += ` The roles from the old ladder (${dropped.map(t => role(t.roleId)).join(', ')}) were left in place; delete them in Server Settings if you no longer need them.`;
  return show(noteGood(note));
}

module.exports = { PAGES, owns, handle, VIEWS };
