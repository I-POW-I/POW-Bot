/**
 * /setup pages for the three alert features:
 *
 *   streamers  Twitch / Kick / YouTube go-live alerts
 *   updates    Game patch-note alerts (Steam, Minecraft, Riot, Fortnite, Blizzard, RSS/Atom)
 *   free       Free game alerts (Epic Games Store + Steam)
 *
 * Everything the old /streamers, /game-updates and /free-games subcommands did lives here now.
 * The slash commands of the same names show what is being watched and link back to these pages.
 *
 * customIds: setup:<page>[:<action>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');

const kit = require('./setupKit');
const { selectAll, selectOne, run } = require('./database');
const { audit } = require('./diagnostics');
const { log }   = require('./logger');
const { parseStreamerUrl } = require('./platforms/parseUrl');
const { SOURCES, parseKey, makeKey, isUpdateKey, fetchLatest, fetchLatestFor } = require('./updates/sources');

const { BLUE, chan, role, noteBad, noteGood, backButton, channelSelect, roleSelect, missingIn, respond } = kit;
const ALERT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const PAGES = ['streamers', 'updates', 'free'];
const owns = (page) => PAGES.includes(page);

// ── Draft state (what the admin has picked but not saved yet) ─────────────────

const drafts = new Map();
const DRAFT_TTL = 20 * 60_000;

function draftOf(guildId, userId, page) {
  const now = Date.now();
  for (const [k, v] of drafts) if (v.expires < now) drafts.delete(k);
  const key = `${guildId}:${userId}:${page}`;
  let d = drafts.get(key);
  if (!d) { d = {}; drafts.set(key, d); }
  d.expires = now + DRAFT_TTL;
  return d;
}

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

const FREE_IDS = require('./freeGames').SQL_IDS;

// ── Streamers ─────────────────────────────────────────────────────────────────

const PLATFORM = { kick: 'Kick', twitch: 'Twitch', youtube: 'YouTube' };

function viewStreamers(guild, user, note) {
  const d = draftOf(guild.id, user.id, 'streamers');
  const rows = selectAll('SELECT * FROM streamer_subscriptions WHERE guild_id = ? ORDER BY platform, display_name, username LIMIT 12', [guild.id]);
  const total = selectOne('SELECT COUNT(*) AS n FROM streamer_subscriptions WHERE guild_id = ?', [guild.id])?.n || 0;
  const lines = rows.map(s => `**${s.display_name || s.username}** (${PLATFORM[s.platform] || s.platform}) · ${s.is_live === 1 ? 'live now' : 'offline'} → ${chan(s.discord_channel_id)}${s.role_id ? ` · ${role(s.role_id)}` : ''}`);

  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Streamer alerts').setDescription([
    note,
    lines.length ? lines.join('\n') + (total > rows.length ? `\n…and ${total - rows.length} more` : '') : 'No streamers are being watched yet.',
    '',
    '**Add a streamer**',
    `1. Alerts channel: ${chan(d.channelId)}`,
    `2. Role to ping (optional): ${d.roleId ? role(d.roleId) : '*none*'}`,
    '3. Press **Add streamer** and paste their channel link (Twitch, Kick or YouTube).',
  ].filter(v => v !== null && v !== undefined).join('\n'));

  return {
    embeds: [embed],
    components: [
      channelSelect('setup:streamers:ch', 'Post live alerts in…', d.channelId, ALERT_CHANNELS),
      roleSelect('setup:streamers:role', 'Role to ping (optional)', d.roleId, true),
      new ActionRowBuilder().addComponents(button('setup:streamers:add', 'Add streamer', ButtonStyle.Primary), button('setup:streamers:rm', 'Remove streamer', ButtonStyle.Secondary, total === 0), backButton()),
    ],
  };
}

function viewStreamerRemove(guild) {
  const subs = selectAll('SELECT * FROM streamer_subscriptions WHERE guild_id = ? ORDER BY platform, display_name, username LIMIT 25', [guild.id]);
  const menu = new StringSelectMenuBuilder().setCustomId('setup:streamers:rmpick').setPlaceholder('Pick a streamer to remove…')
    .addOptions(subs.map(s => ({ label: String(s.display_name || s.username).slice(0, 100), value: String(s.id), description: `${PLATFORM[s.platform] || s.platform} · ${s.is_live === 1 ? 'live now' : 'offline'}` })));
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Remove a streamer').setDescription(subs.length ? 'Pick the streamer to stop watching.' : 'No streamers to remove.')],
    components: subs.length ? [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(backButton('streamers'))] : [new ActionRowBuilder().addComponents(backButton('streamers'))],
  };
}

function streamerModal() {
  return new ModalBuilder().setCustomId('setup:streamers:addmodal').setTitle('Add a streamer').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('Channel link').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setPlaceholder('https://twitch.tv/name · https://kick.com/name · https://youtube.com/@handle')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Display name (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50)),
  );
}

async function addStreamer(guild, by, d, input, overrideName) {
  const fail = (text) => ({ ok: false, text });
  const parsed = parseStreamerUrl(String(input || ''));
  if (!parsed) return fail('I could not recognise that link. Use `https://twitch.tv/name`, `https://kick.com/name` or `https://youtube.com/@handle`.');

  let { platform, username, displayHint } = parsed;
  if (platform === 'youtube' && parsed.needsResolve) {
    if (!process.env.YOUTUBE_API_KEY) return fail('YouTube alerts are not available yet: the bot owner needs to add `YOUTUBE_API_KEY` to the bot settings.');
    const channelId = await require('./platforms/youtube').resolveHandle(username);
    if (!channelId) return fail(`I could not find a YouTube channel for **${username}**. Try the direct link: \`https://youtube.com/channel/UC…\``);
    username = channelId;
  }

  if (selectOne('SELECT id FROM streamer_subscriptions WHERE guild_id = ? AND platform = ? AND username = ?', [guild.id, platform, username])) return fail('That streamer is already being watched in this server.');

  const channel = guild.channels.cache.get(d.channelId);
  if (!channel) return fail('The alerts channel no longer exists. Pick it again.');
  const missing = missingIn(channel, guild);
  if (missing.length) return fail(`I can't post in ${channel}: missing **${missing.join(', ')}**.`);

  let displayName = overrideName || null;
  if (!displayName) {
    if (platform === 'twitch') displayName = await require('./platforms/twitch').getDisplayName(username).catch(() => null);
    else if (platform === 'youtube') displayName = await require('./platforms/youtube').getDisplayName(username).catch(() => null);
    displayName = displayName || displayHint || username;
  }

  run('INSERT INTO streamer_subscriptions (guild_id, platform, username, display_name, discord_channel_id, role_id, is_live) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [guild.id, platform, username, displayName, channel.id, d.roleId || null]);
  audit({ action: 'Streamer added', actor: by, guild, details: `${displayName} (${PLATFORM[platform]}) → #${channel.name}` });
  if (platform === 'twitch') require('./platforms/twitchEventSub').requestSync();   // instant alerts (no-op when EventSub is off)
  return { ok: true, text: `Now watching **${displayName}** on ${PLATFORM[platform]}. Alerts go to ${channel}${d.roleId ? `, pinging ${role(d.roleId)}` : ''}.` };
}

async function handleStreamers(interaction, { guild, by, action }) {
  const d = draftOf(guild.id, by.id, 'streamers');
  const show = (note) => respond(interaction, viewStreamers(guild, by, note));

  if (!action) return show();
  if (action === 'ch') {
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    d.channelId = channel.id;
    return show();
  }
  if (action === 'role') { d.roleId = interaction.roles.first()?.id || null; return show(); }
  if (action === 'add') {
    if (!d.channelId) return show(noteBad('Choose the alerts channel first.'));
    return interaction.showModal(streamerModal());
  }
  if (action === 'addmodal') {
    await interaction.deferUpdate();
    const res = await addStreamer(guild, by, d, interaction.fields.getTextInputValue('url'), interaction.fields.getTextInputValue('name').trim());
    return show(res.ok ? noteGood(res.text) : noteBad(res.text));
  }
  if (action === 'rm') return respond(interaction, viewStreamerRemove(guild));
  if (action === 'rmpick') {
    const sub = selectOne('SELECT * FROM streamer_subscriptions WHERE id = ? AND guild_id = ?', [interaction.values[0], guild.id]);
    if (!sub) return show(noteBad('That streamer was already removed.'));
    run('DELETE FROM streamer_subscriptions WHERE id = ?', [sub.id]);
    audit({ action: 'Streamer removed', actor: by, guild, details: `${sub.display_name || sub.username} (${PLATFORM[sub.platform]})` });
    return show(noteGood(`Stopped watching **${sub.display_name || sub.username}**.`));
  }
  return false;
}

// ── Game updates ──────────────────────────────────────────────────────────────

const MAX_UPDATES = 20;
const subsOf = (guildId) => selectAll(`SELECT * FROM game_subscriptions WHERE guild_id = ? AND app_id NOT IN ${FREE_IDS} ORDER BY game_name`, [guildId]);
const sourceLabel = (sub) => SOURCES[parseKey(sub.app_id).source]?.label || 'Steam';
const alertLabel = (sub) => `${sub.game_name || sub.app_id} (${sourceLabel(sub)})`;

function viewUpdates(guild, user, note) {
  const d = draftOf(guild.id, user.id, 'updates');
  const subs = subsOf(guild.id);
  const lines = subs.slice(0, 8).map(s => `**${s.game_name || s.app_id}** (${sourceLabel(s)}) → ${chan(s.channel_id)}${s.role_id ? ` · ${role(s.role_id)}` : ''}`);
  const src = d.source ? SOURCES[d.source] : null;
  const gameText = d.source === 'rss' ? (d.value || '*not entered*') : (d.name || '*not chosen*');
  const ready = !!(d.source && d.value && d.channelId);

  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Game update alerts').setDescription([
    note,
    lines.length ? lines.join('\n') + (subs.length > 8 ? `\n…and ${subs.length - 8} more (press **Manage alerts**)` : '') : 'No game update alerts yet.',
    '',
    '**Add an alert**',
    `1. Source: ${src ? `${src.label}${src.beta ? ' (beta)' : ''}` : '*not chosen*'}`,
    `2. ${d.source === 'rss' ? 'Feed' : 'Game'}: ${gameText}`,
    `3. Channel: ${chan(d.channelId)}`,
    `4. Role to ping (optional): ${d.roleId ? role(d.roleId) : '*none*'}`,
    'Press **Add alert** when steps 1 to 3 are done. Only updates released from now on are posted.',
  ].filter(v => v !== null && v !== undefined).join('\n'));

  const components = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('setup:updates:src').setPlaceholder('1. Choose a source…')
      .addOptions(Object.entries(SOURCES).map(([value, s]) => ({ label: s.label, value, description: s.beta ? 'Beta: reads the publisher\'s news page' : undefined, default: d.source === value }))))];

  const fixed = d.source && SOURCES[d.source]?.games;
  if (fixed) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:updates:game').setPlaceholder('2. Choose a game…')
      .addOptions(fixed.slice(0, 25).map(g => ({ label: g.name.slice(0, 100), value: g.value, default: d.value === g.value })))));
  } else if (d.source === 'steam' && d.matches?.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:updates:game').setPlaceholder('2. Pick the matching game…')
      .addOptions(d.matches.map(g => ({ label: g.name.slice(0, 100), value: String(g.appid), default: d.value === String(g.appid) })))));
  }
  components.push(channelSelect('setup:updates:ch', '3. Channel for the updates…', d.channelId, ALERT_CHANNELS));
  components.push(roleSelect('setup:updates:role', '4. Role to ping (optional)', d.roleId, true));

  const buttons = [];
  if (d.source === 'steam') buttons.push(button('setup:updates:find', 'Search Steam'));
  if (d.source === 'rss')   buttons.push(button('setup:updates:find', 'Enter feed URL'));
  buttons.push(button('setup:updates:add', 'Add alert', ButtonStyle.Primary, !ready));
  buttons.push(button('setup:updates:manage', 'Manage alerts', ButtonStyle.Secondary, subs.length === 0));
  buttons.push(backButton());
  components.push(new ActionRowBuilder().addComponents(buttons));
  return { embeds: [embed], components };
}

function viewUpdateList(guild) {
  const subs = subsOf(guild.id).slice(0, 25);
  const menu = new StringSelectMenuBuilder().setCustomId('setup:updates:pick').setPlaceholder('Pick an alert to change…')
    .addOptions(subs.map(s => ({ label: alertLabel(s).slice(0, 100), value: String(s.id), description: `#${guild.channels.cache.get(s.channel_id)?.name || 'deleted-channel'}` })));
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Manage game update alerts').setDescription(subs.length ? 'Pick an alert to change its channel or ping, send its latest post as a test (it never pings the role), or remove it.' : 'No alerts yet.')],
    components: subs.length ? [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(backButton('updates'))] : [new ActionRowBuilder().addComponents(backButton('updates'))],
  };
}

function viewUpdateOne(guild, sub, note) {
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(alertLabel(sub)).setDescription([note,
      `Channel: ${chan(sub.channel_id)}`, `Ping: ${sub.role_id ? role(sub.role_id) : '*none*'}`].filter(Boolean).join('\n'))],
    components: [
      channelSelect(`setup:updates:och:${sub.id}`, 'Move this alert to another channel…', sub.channel_id, ALERT_CHANNELS),
      roleSelect(`setup:updates:orole:${sub.id}`, 'Role to ping (deselect for none)', sub.role_id, true),
      new ActionRowBuilder().addComponents(button(`setup:updates:otest:${sub.id}`, 'Send latest post as a test', ButtonStyle.Primary), button(`setup:updates:orm:${sub.id}`, 'Remove alert', ButtonStyle.Danger), backButton('updates:manage', 'Back to list')),
    ],
  };
}

function findModal(source) {
  return new ModalBuilder().setCustomId('setup:updates:findmodal').setTitle(source === 'rss' ? 'RSS / Atom feed' : 'Search Steam').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel(source === 'rss' ? 'Feed URL' : 'Game name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
      .setPlaceholder(source === 'rss' ? 'https://example.com/feed.xml' : 'e.g. Counter-Strike 2')));
}

async function addUpdate(guild, by, d) {
  const fail = (text) => ({ ok: false, text });
  const channel = guild.channels.cache.get(d.channelId);
  if (!channel) return fail('The channel no longer exists. Pick it again.');
  const missing = missingIn(channel, guild);
  if (missing.length) return fail(`I can't post in ${channel}: missing **${missing.join(', ')}**.`);
  if (subsOf(guild.id).length >= MAX_UPDATES) return fail(`This server already watches ${MAX_UPDATES} games. Remove one first.`);

  const key = makeKey(d.source, d.value);
  if (selectOne('SELECT id FROM game_subscriptions WHERE guild_id = ? AND app_id = ?', [guild.id, key])) return fail('This server already has that alert. Use **Manage alerts** to change it.');

  let name = d.name || SOURCES[d.source]?.games?.find(g => g.value === d.value)?.name || null;
  let latest = null, extra = '';
  try { latest = await fetchLatestFor(d.source, d.value, name); }
  catch (err) {
    if (!SOURCES[d.source].beta) return fail(`I couldn't read that source: ${err.message}`);
    extra = ` I couldn't read **${name || d.value}** just now (${err.message}); it's saved and I'll keep trying.`;
  }
  name = name || latest?.game || d.value;

  run('INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id, last_post_id) VALUES (?, ?, ?, ?, ?, ?)',
    [guild.id, key, name, channel.id, d.roleId || null, latest ? String(latest.id) : null]);
  audit({ action: 'Game update alert added', actor: by, guild, details: `${name} (${SOURCES[d.source].label}) → #${channel.name}` });
  return { ok: true, text: `Now watching **${name}** (${SOURCES[d.source].label}) in ${channel}${d.roleId ? `, pinging ${role(d.roleId)}` : ''}.${latest ? ` Latest right now: *${latest.title}*. Only newer updates will be posted. To see how a post looks, open **Manage alerts** and press **Send latest post as a test**.` : ' No updates found yet; the next one will be posted automatically.'}${extra}` };
}

async function handleUpdates(interaction, { guild, by, action, arg, client }) {
  const d = draftOf(guild.id, by.id, 'updates');
  const show = (note) => respond(interaction, viewUpdates(guild, by, note));
  const one = (id) => { const s = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [id, guild.id]); return s && isUpdateKey(s.app_id) ? s : null; };
  const showOne = (sub, note) => respond(interaction, viewUpdateOne(guild, sub, note));
  const gone = () => respond(interaction, { ...viewUpdateList(guild), content: 'That alert no longer exists.' });

  if (!action) return show();
  if (action === 'src') { const v = interaction.values[0]; if (d.source !== v) { d.source = v; d.value = null; d.name = null; d.matches = null; } return show(); }
  if (action === 'game') {
    d.value = interaction.values[0];
    d.name = d.source === 'steam' ? d.matches?.find(m => String(m.appid) === d.value)?.name || null : SOURCES[d.source]?.games?.find(g => g.value === d.value)?.name || null;
    return show();
  }
  if (action === 'ch') {
    const channel = interaction.channels.first(), missing = missingIn(channel, guild);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    d.channelId = channel.id; return show();
  }
  if (action === 'role') { d.roleId = interaction.roles.first()?.id || null; return show(); }
  if (action === 'find') return interaction.showModal(findModal(d.source));
  if (action === 'findmodal') {
    await interaction.deferUpdate();
    const q = interaction.fields.getTextInputValue('q').trim();
    if (d.source === 'rss') {
      if (!/^https?:\/\/\S+$/i.test(q)) return show(noteBad('Paste the full feed URL, starting with https://'));
      d.value = q; d.name = null; return show();
    }
    const found = await require('./platforms/steam').searchGames(q);
    if (!found.length) return show(noteBad(`Steam has no game matching "${q}".`));
    d.matches = found; d.value = null; d.name = null;
    return show('Pick the matching game from the list.');
  }
  if (action === 'add') {
    await interaction.deferUpdate();
    if (!d.source || !d.value || !d.channelId) return show(noteBad('Choose a source, a game and a channel first.'));
    const res = await addUpdate(guild, by, d);
    if (res.ok) { d.value = null; d.name = null; d.matches = null; }
    return show(res.ok ? noteGood(res.text) : noteBad(res.text));
  }
  if (action === 'manage') return respond(interaction, viewUpdateList(guild));
  if (action === 'pick') { const s = one(interaction.values[0]); return s ? showOne(s) : gone(); }

  // Controls for one existing alert (arg = subscription id)
  const sub = one(arg);
  if (!sub) return gone();
  if (action === 'och') {
    const channel = interaction.channels.first(), missing = missingIn(channel, guild);
    if (missing.length) return showOne(sub, noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    run('UPDATE game_subscriptions SET channel_id = ? WHERE id = ?', [channel.id, sub.id]);
    audit({ action: 'Game update alert moved', actor: by, guild, details: `${sub.game_name} → #${channel.name}` });
    return showOne({ ...sub, channel_id: channel.id }, noteGood(`Now posts in ${channel}.`));
  }
  if (action === 'orole') {
    const r = interaction.roles.first();
    run('UPDATE game_subscriptions SET role_id = ? WHERE id = ?', [r?.id || null, sub.id]);
    audit({ action: 'Game update ping changed', actor: by, guild, details: `${sub.game_name} → ${r ? '@' + r.name : 'no ping'}` });
    return showOne({ ...sub, role_id: r?.id || null }, noteGood(r ? `Now pings ${r}.` : 'No longer pings a role.'));
  }
  if (action === 'orm') {
    run('DELETE FROM game_subscriptions WHERE id = ?', [sub.id]);
    audit({ action: 'Game update alert removed', actor: by, guild, details: sub.game_name });
    return respond(interaction, { ...viewUpdateList(guild), content: `Stopped watching **${sub.game_name}**.` });
  }
  if (action === 'otest') {
    await interaction.deferUpdate();
    try {
      const update = await fetchLatest(sub);
      if (!update) return showOne(sub, `No updates found for **${sub.game_name}** yet.`);
      const ok = await require('./gamePoller').postUpdate(client || interaction.client, { ...sub, role_id: null }, update);   // a test never pings the role
      return showOne(sub, ok ? noteGood(`Posted the latest update (*${update.title}*) in ${chan(sub.channel_id)}.`) : noteBad(`I couldn't post in ${chan(sub.channel_id)}. Check my permissions there.`));
    } catch (err) {
      log('WARN', 'Game update test failed', { game: sub.game_name, err });
      return showOne(sub, noteBad(`I couldn't read the updates: ${err.message}`));
    }
  }
  return false;
}

// ── Free games ────────────────────────────────────────────────────────────────

const { STORES, IDS } = require('./freeGames');
const freeRows = (guildId) => selectAll(`SELECT * FROM game_subscriptions WHERE guild_id = ? AND app_id IN ${FREE_IDS}`, [guildId]);

/** Point every followed store at one channel and role. The first time, all stores are switched on. */
function saveFree(guild, channelId, roleId) {
  const rows = freeRows(guild.id);
  if (!rows.length) {
    for (const appId of IDS) run('INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id) VALUES (?, ?, ?, ?, ?)', [guild.id, appId, STORES[appId].rowName, channelId, roleId]);
    return;
  }
  for (const row of rows) run('UPDATE game_subscriptions SET channel_id = ?, role_id = ? WHERE id = ?', [channelId, roleId, row.id]);
}

function viewFree(guild, note) {
  const rows = freeRows(guild.id), current = rows[0], on = new Set(rows.map(r => r.app_id));
  const stores = IDS.map(id => `${on.has(id) ? 'On' : 'Off'}: ${STORES[id].label}`);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Free game alerts').setDescription([note,
      `Channel: ${current ? chan(current.channel_id) : '*not set*'}`,
      `Ping: ${current?.role_id ? role(current.role_id) : '*none*'}`,
      '',
      '**Stores**',
      ...stores,
      '',
      current ? 'Each new free game is posted as its own message. Use the buttons to follow or stop following a store.' : 'Pick a channel to start. Epic, Steam and GOG are all switched on, and you can turn any of them off.'].filter(v => v !== null && v !== undefined).join('\n'))],
    components: [
      channelSelect('setup:free:ch', 'Post free games in…', current?.channel_id, ALERT_CHANNELS),
      roleSelect('setup:free:role', 'Role to ping (optional)', current?.role_id, true),
      new ActionRowBuilder().addComponents(...IDS.map(id => button(`setup:free:store:${id}`, `${STORES[id].short}: ${on.has(id) ? 'on' : 'off'}`, on.has(id) ? ButtonStyle.Success : ButtonStyle.Secondary, !current))),
      new ActionRowBuilder().addComponents(button('setup:free:off', 'Turn all off', ButtonStyle.Danger, !current), backButton()),
    ],
  };
}

async function handleFree(interaction, { guild, by, action, arg }) {
  const show = (note) => respond(interaction, viewFree(guild, note));
  const current = freeRows(guild.id)[0];

  if (!action) return show();
  if (action === 'ch') {
    const channel = interaction.channels.first(), missing = missingIn(channel, guild);
    if (missing.length) return show(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    saveFree(guild, channel.id, current?.role_id || null);
    audit({ action: current ? 'Free game alerts changed' : 'Free game alerts set up', actor: by, guild, details: `→ #${channel.name}` });
    return show(noteGood(`Free game alerts go to ${channel}.`));
  }
  if (action === 'role') {
    if (!current) return show(noteBad('Choose a channel first.'));
    const r = interaction.roles.first();
    saveFree(guild, current.channel_id, r?.id || null);
    audit({ action: 'Free game ping changed', actor: by, guild, details: r ? `@${r.name}` : 'no ping' });
    return show(noteGood(r ? `Now pings ${r}.` : 'No longer pings a role.'));
  }
  if (action === 'store') {
    if (!current || !STORES[arg]) return show(noteBad('Choose a channel first.'));
    const existing = selectOne('SELECT id FROM game_subscriptions WHERE guild_id = ? AND app_id = ?', [guild.id, arg]);
    if (existing) run('DELETE FROM game_subscriptions WHERE id = ?', [existing.id]);
    else run('INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id) VALUES (?, ?, ?, ?, ?)', [guild.id, arg, STORES[arg].rowName, current.channel_id, current.role_id]);
    audit({ action: `Free games on ${STORES[arg].label}`, actor: by, guild, details: existing ? 'off' : 'on' });
    if (!freeRows(guild.id).length) return show(noteGood(`${STORES[arg].label} is off. No stores are followed, so free game alerts are off.`));
    return show(noteGood(`${STORES[arg].label} is now ${existing ? 'off' : 'on'}.`));
  }
  if (action === 'off') {
    run(`DELETE FROM game_subscriptions WHERE guild_id = ? AND app_id IN ${FREE_IDS}`, [guild.id]);
    audit({ action: 'Free game alerts removed', actor: by, guild });
    return show(noteGood('Free game alerts turned off.'));
  }
  return false;
}

// ── Entry point used by setup.js ──────────────────────────────────────────────

const VIEWS = {
  streamers: (guild, user, note) => viewStreamers(guild, user, note),
  updates:   (guild, user, note) => viewUpdates(guild, user, note),
  free:      (guild, user, note) => viewFree(guild, note),
};

/** Returns true when the interaction was handled here. */
async function handle(interaction, ctx) {
  const handlers = { streamers: handleStreamers, updates: handleUpdates, free: handleFree };
  const res = await handlers[ctx.page](interaction, ctx);
  return res !== false;
}

module.exports = { PAGES, owns, handle, VIEWS, subsOf, freeRows, FREE_IDS, _drafts: drafts };
