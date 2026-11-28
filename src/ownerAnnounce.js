/**
 * Announcements section of the owner hub (/owner -> Announcements).
 *
 * The flow, all on one private screen:
 *   1. choose a style and fill in the form          (src/announcements.js has the styles)
 *   2. preview exactly what will be posted
 *   3. choose the servers: nothing is selected by default, and each server shows whether it has an
 *      announcement channel set in /setup
 *   4. review where it goes in each server, change a channel, or reuse the channels chosen last time
 *   5. confirm and send
 *
 * Only the bot owner can use this. Mentions are disabled in everything that is sent.
 *
 * customIds: owner:ann_<action>:<draft>[:<arg>]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const crypto = require('crypto');

const globalConfig = require('./globalConfig');
const announcements = require('./announcements');
const { getGuildConfig } = require('./guildConfig');
const { audit } = require('./diagnostics');

const BLUE = 0x5865F2, AMBER = 0xFAA61A;
const PAGE = 20, TTL = 30 * 60_000;
const ephemeral = [MessageFlags.Ephemeral];
const n = (v) => Number(v || 0).toLocaleString('en-GB');

const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const backToSection = () => btn('owner:to:announce', 'Back');

// ── Drafts (in memory, 30 minutes) ────────────────────────────────────────────

const drafts = new Map();
function newDraft(userId, style, values) {
  const now = Date.now();
  for (const [k, v] of drafts) if (v.expires < now) drafts.delete(k);
  const id = crypto.randomBytes(4).toString('hex');
  drafts.set(id, { userId, style, values, format: { ...announcements.DEFAULT_FORMAT }, selected: new Set(), overrides: new Map(), expires: now + TTL });
  return id;
}
function draftOf(id, userId) {
  const d = drafts.get(id);
  if (!d || d.expires < Date.now() || d.userId !== userId) return null;
  d.expires = Date.now() + TTL;
  return d;
}

// ── Servers and channels ──────────────────────────────────────────────────────

const guildsOf = (client) => [...client.guilds.cache.values()].filter(g => !globalConfig.isGuildBanned(g.id)).sort((a, b) => b.memberCount - a.memberCount);

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const canPost = (guild, ch) => !!ch && CHANNEL_TYPES.includes(ch.type)
  && !!ch.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);

const lastChannel = (guild) => {
  const ch = guild.channels.cache.get(globalConfig.get().announce.lastChannels[guild.id]);
  return canPost(guild, ch) ? ch : null;
};

/** Does the server have a working announcement channel (set in /setup)? */
function announcementChannel(guild) {
  const id = getGuildConfig(guild.id).announceChannelId;
  if (!id) return { state: 'none' };
  const ch = guild.channels.cache.get(id);
  return canPost(guild, ch) ? { state: 'ok', channel: ch } : { state: 'broken' };
}

const STATE_TEXT = { ok: (c) => `announcement channel #${c.channel.name}`, none: () => 'no announcement channel set', broken: () => 'announcement channel set but unusable' };
const stateText = (guild) => { const a = announcementChannel(guild); return STATE_TEXT[a.state](a); };

/** Where it will be posted in a server: your choice, else its announcement channel, else a fallback. */
function targetFor(guild, d) {
  const chosen = guild.channels.cache.get(d.overrides.get(guild.id));
  if (canPost(guild, chosen)) return { channel: chosen, how: 'chosen by you' };
  const a = announcementChannel(guild);
  if (a.state === 'ok') return { channel: a.channel, how: 'announcement channel' };
  const cfg = getGuildConfig(guild.id);
  for (const [id, name] of [[cfg.panelChannelId, 'panel channel']]) {
    const ch = id && guild.channels.cache.get(id);
    if (canPost(guild, ch)) return { channel: ch, how: `fallback: ${name}, ${a.state === 'none' ? 'no announcement channel set' : 'announcement channel unusable'}` };
  }
  if (canPost(guild, guild.systemChannel)) return { channel: guild.systemChannel, how: `fallback: system channel, ${a.state === 'none' ? 'no announcement channel set' : 'announcement channel unusable'}` };
  return null;
}

// ── Screens ───────────────────────────────────────────────────────────────────

function viewHome(note) {
  const select = new StringSelectMenuBuilder().setCustomId('owner:ann_style').setPlaceholder('Choose a style to start')
    .addOptions(Object.entries(announcements.STYLES).map(([value, s]) => ({ label: s.label, value, description: s.desc.slice(0, 100), emoji: s.emoji })));
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Announcements').setDescription([note,
      'Post a changelog, an update, a maintenance notice or other news to the servers you choose.',
      '',
      'You write it, preview it, then choose the servers and the channel in each one. Nothing is selected for you, and nothing is sent until you confirm.'].filter(Boolean).join('\n'))],
    components: [row(select), row(btn('owner:ann_hist', 'Sent announcements'), btn('owner:home', 'Back'))],
  };
}

const modalFor = (styleKey, nonce, values = {}) => {
  const style = announcements.STYLES[styleKey];
  const modal = new ModalBuilder().setCustomId(`owner:ann_modal:${styleKey}:${nonce}`).setTitle(style.label);
  for (const f of style.fields) {
    const input = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.style === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required).setMaxLength(f.max);
    if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));
    if (values[f.id]) input.setValue(String(values[f.id]).slice(0, f.max));
    modal.addComponents(row(input));
  }
  return modal;
};

function viewPreview(nonce, d, note) {
  const built = announcements.build(d.style, d.values, d.format);
  const label = announcements.STYLES[d.style].label;
  if (built.error) {
    return { content: null, embeds: [new EmbedBuilder().setColor(AMBER).setTitle(`${label}: needs a change`).setDescription(built.error)],
      components: [row(btn(`owner:ann_edit:${nonce}`, 'Edit text', ButtonStyle.Primary), btn(`owner:ann_cancel:${nonce}`, 'Discard'))] };
  }
  const info = new EmbedBuilder().setColor(BLUE).setTitle(`Preview: ${label}`).setDescription([note, 'This is exactly what will be posted. Next, choose the servers.'].filter(Boolean).join('\n'));
  return {
    content: built.payload.content || null,
    embeds: [...(built.payload.embeds || []), info],
    components: [row(btn(`owner:ann_edit:${nonce}`, 'Edit text'), btn(`owner:ann_fmt:${nonce}`, 'Format text'), btn(`owner:ann_servers:${nonce}:0`, 'Choose servers', ButtonStyle.Primary), btn(`owner:ann_cancel:${nonce}`, 'Discard'))],
  };
}

function viewFormat(nonce, d, note) {
  const f = d.format, A = announcements;
  const pick = (kind, ph, options, cur) => row(new StringSelectMenuBuilder().setCustomId(`owner:ann_fset:${nonce}:${kind}`).setPlaceholder(ph)
    .addOptions(options.map(([value, label]) => ({ label, value, default: cur === value }))));
  const embedStyle = ['changelog', 'plain'].includes(d.style) ? false : true;
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Format text').setDescription([note,
      'Change how the message reads. The preview updates as you choose.',
      '',
      `**Title:** ${A.TITLE_STYLES[f.title]}`,
      `**List lines as:** ${A.BULLET_STYLES[f.bullets]}`,
      embedStyle ? `**Colour:** ${A.COLOUR_CHOICES[f.colour][0]}` : null,
      `**Bold words:** ${f.boldWords.length ? f.boldWords.join(', ') : 'none'}`,
      embedStyle ? `**Footer:** ${f.footer ? 'shown' : 'hidden'}` : null,
      '',
      '-# Text you type yourself can also use **bold**, *italics*, __underline__, ~~strike~~ and `code`.'].filter(v => v !== null && v !== undefined).join('\n'))],
    components: [
      pick('title', 'Title style', Object.entries(A.TITLE_STYLES), f.title),
      pick('bullets', 'List lines as…', Object.entries(A.BULLET_STYLES), f.bullets),
      ...(embedStyle ? [pick('colour', 'Colour', Object.entries(A.COLOUR_CHOICES).map(([k, [label]]) => [k, label]), f.colour)] : []),
      row(btn(`owner:ann_fwords:${nonce}`, 'Bold words…'), ...(embedStyle ? [btn(`owner:ann_ffoot:${nonce}`, f.footer ? 'Hide footer' : 'Show footer')] : []), btn(`owner:ann_freset:${nonce}`, 'Reset'), btn(`owner:ann_preview:${nonce}`, 'Back to preview', ButtonStyle.Primary)),
    ],
  };
}

function viewServers(client, nonce, d, page, note) {
  const guilds = guildsOf(client), pages = Math.max(1, Math.ceil(guilds.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = guilds.slice(page * PAGE, page * PAGE + PAGE);
  const lines = slice.map(g => `${d.selected.has(g.id) ? '**[selected]** ' : ''}**${g.name}** · ${n(g.memberCount)} members · ${stateText(g)}`);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`Choose servers (${d.selected.size} selected)`)
    .setDescription([note, 'Nothing is selected by default. Pick the servers that should get this announcement.', '', lines.join('\n') || 'The bot is not in any server.'].filter(v => v !== null && v !== undefined).join('\n').slice(0, 3900))
    .setFooter({ text: `Page ${page + 1} of ${pages} · ${guilds.length} server(s)` });
  const components = [];
  if (slice.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId(`owner:ann_pick:${nonce}:${page}`).setPlaceholder('Select servers on this page').setMinValues(0).setMaxValues(slice.length)
      .addOptions(slice.map(g => ({ label: g.name.slice(0, 100), value: g.id, default: d.selected.has(g.id), description: `${n(g.memberCount)} members · ${stateText(g)}`.slice(0, 100) })))));
  }
  components.push(row(btn(`owner:ann_pg:${nonce}:${page - 1}`, 'Previous', ButtonStyle.Secondary, page === 0), btn(`owner:ann_pg:${nonce}:${page + 1}`, 'Next', ButtonStyle.Secondary, page >= pages - 1),
    btn(`owner:ann_all:${nonce}:${page}`, 'Select all with an announcement channel'), btn(`owner:ann_none:${nonce}:${page}`, 'Clear selection', ButtonStyle.Secondary, !d.selected.size)));
  components.push(row(btn(`owner:ann_preview:${nonce}`, 'Back to preview'), btn(`owner:ann_review:${nonce}`, `Review (${d.selected.size})`, ButtonStyle.Primary, !d.selected.size)));
  return { content: null, embeds: [embed], components };
}

function selectedGuilds(client, d) {
  return guildsOf(client).filter(g => d.selected.has(g.id));
}

function viewReview(client, nonce, d, note) {
  const chosen = selectedGuilds(client, d);
  let willSend = 0, fallback = 0;
  const lines = chosen.map(g => {
    const t = targetFor(g, d);
    if (!t) return `**${g.name}**: no channel I can post in (will be skipped)`;
    willSend++; if (t.how.startsWith('fallback')) fallback++;
    return `**${g.name}** → #${t.channel.name} *(${t.how})*`;
  });
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`Review: ${willSend} of ${chosen.length} server(s) will receive it`)
    .setDescription([note, lines.join('\n').slice(0, 3600), fallback ? `\n${fallback} server(s) have no working announcement channel, so a fallback is used. Change the channel for them if you prefer.` : null].filter(Boolean).join('\n'))
    .setFooter({ text: 'Channels you choose are remembered for next time.' });
  const components = [];
  if (chosen.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId(`owner:ann_chg:${nonce}`).setPlaceholder('Change the channel for a server')
      .addOptions(chosen.slice(0, 25).map(g => ({ label: g.name.slice(0, 100), value: g.id, description: stateText(g).slice(0, 100) })))));
  }
  const hasLast = chosen.some(g => lastChannel(g));
  components.push(row(btn(`owner:ann_last:${nonce}`, 'Use the channels from last time', ButtonStyle.Secondary, !hasLast), btn(`owner:ann_servers:${nonce}:0`, 'Back to servers'),
    btn(`owner:ann_confirm:${nonce}`, willSend ? `Send to ${willSend} server(s)` : 'Nothing to send', ButtonStyle.Primary, !willSend)));
  return { content: null, embeds: [embed], components };
}

function viewChannelPick(guild, nonce, d) {
  const current = d.overrides.get(guild.id), last = lastChannel(guild), a = announcementChannel(guild);
  const options = [{ label: a.state === 'ok' ? `Announcement channel (#${a.channel.name})` : 'Automatic', value: '__auto', description: a.state === 'ok' ? 'The channel the server set in /setup' : 'No announcement channel set: a fallback is used', default: !current }];
  if (last) options.push({ label: `Last time: #${last.name}`.slice(0, 100), value: last.id, description: 'The channel you chose for this server before', default: current === last.id });
  const seen = new Set(options.map(o => o.value));
  const channels = [...guild.channels.cache.values()].filter(c => canPost(guild, c) && !seen.has(c.id)).sort((x, y) => x.rawPosition - y.rawPosition).slice(0, 25 - options.length);
  for (const c of channels) options.push({ label: `#${c.name}`.slice(0, 100), value: c.id, default: current === c.id });
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`Channel for ${guild.name}`).setDescription([`Status: ${stateText(guild)}.`, channels.length || last ? 'Pick where this server should receive the announcement.' : 'I can\'t post in any other channel there.'].join('\n'))],
    components: [row(new StringSelectMenuBuilder().setCustomId(`owner:ann_ch:${nonce}:${guild.id}`).setPlaceholder('Choose a channel').addOptions(options)), row(btn(`owner:ann_review:${nonce}`, 'Back to review'))],
  };
}

function viewConfirm(client, nonce, d) {
  const built = announcements.build(d.style, d.values, d.format);
  const count = selectedGuilds(client, d).filter(g => targetFor(g, d)).length;
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(AMBER).setTitle(`Send "${built.title}" to ${count} server(s)?`).setDescription('This posts the message in each server\'s channel straight away and cannot be undone.')],
    components: [row(btn(`owner:ann_send:${nonce}`, 'Send now', ButtonStyle.Danger), btn(`owner:ann_review:${nonce}`, 'Back to review'))],
  };
}

function viewHistory() {
  const items = announcements.recent(10);
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Sent announcements').setDescription(items.length
      ? items.map(a => `**${a.title}** · ${announcements.STYLES[a.style]?.label || a.style} · <t:${Math.floor(a.sent_at / 1000)}:d> · ${a.servers} server(s)`).join('\n')
      : 'Nothing has been sent yet.')],
    components: [row(backToSection())],
  };
}

// ── Sending ───────────────────────────────────────────────────────────────────

async function send(interaction, client, d) {
  const built = announcements.build(d.style, d.values, d.format);
  const sent = [], failed = [], skipped = [];
  for (const guild of selectedGuilds(client, d)) {
    const target = targetFor(guild, d);
    if (!target) { skipped.push(guild.name); continue; }
    try { await target.channel.send(built.payload); sent.push(guild); } catch (err) { failed.push(`${guild.name} (${err.message.slice(0, 40)})`); }
    await new Promise(r => setTimeout(r, 400));
  }
  globalConfig.update(s => { for (const [gid, ch] of d.overrides) if (sent.some(g => g.id === gid)) s.announce.lastChannels[gid] = ch; });
  announcements.record({ style: d.style, title: built.title, payload: built.payload, by: interaction.user.tag || interaction.user.id, servers: sent.length });
  audit({ action: 'Announcement sent', actor: interaction.user, details: `"${built.title}" (${d.style}) to ${sent.length} server(s), ${failed.length + skipped.length} not reached` });
  return { sent: sent.length, failed, skipped };
}

// ── Interaction routing ───────────────────────────────────────────────────────

async function respond(interaction, view) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(view);
  if (interaction.isFromMessage?.() || interaction.isMessageComponent?.()) return interaction.update(view);
  return interaction.reply({ ...view, flags: ephemeral });
}

/** Returns true when the interaction belonged to the announcements section. */
async function handle(interaction, client) {
  const parts = interaction.customId.split(':'), action = parts[1];
  if (!action.startsWith('ann_')) return false;
  const uid = interaction.user.id, nonce = parts[2];

  if (interaction.isModalSubmit() && action === 'ann_modal') {
    const style = parts[2], key = parts[3];
    if (!announcements.STYLES[style]) return true;
    const values = Object.fromEntries(announcements.STYLES[style].fields.map(f => [f.id, interaction.fields.getTextInputValue(f.id)]));
    let id = key;
    if (key === 'new') id = newDraft(uid, style, values);
    else { const d = draftOf(key, uid); if (d) d.values = values; else id = newDraft(uid, style, values); }
    await respond(interaction, viewPreview(id, drafts.get(id)));
    return true;
  }

  if (interaction.isModalSubmit() && action === 'ann_wordsmodal') {
    const d = draftOf(nonce, uid);
    if (!d) { await respond(interaction, { content: 'That announcement expired. Start again from Announcements.', embeds: [], components: [row(backToSection())] }); return true; }
    d.format.boldWords = interaction.fields.getTextInputValue('words').split(/[,\n]/).map(w => w.trim()).filter(Boolean).slice(0, 12);
    await respond(interaction, viewFormat(nonce, d, 'Bold words saved.'));
    return true;
  }

  if (action === 'ann_style') { await interaction.showModal(modalFor(interaction.values[0], 'new')); return true; }
  if (action === 'ann_hist') { await respond(interaction, viewHistory()); return true; }

  const d = draftOf(nonce, uid);
  if (!d) {
    await respond(interaction, { content: 'That announcement expired. Start again from Announcements.', embeds: [], components: [row(backToSection())] });
    return true;
  }

  switch (action) {
    case 'ann_edit': await interaction.showModal(modalFor(d.style, nonce, d.values)); return true;
    case 'ann_cancel': drafts.delete(nonce); await respond(interaction, viewHome('Discarded.')); return true;
    case 'ann_preview': await respond(interaction, viewPreview(nonce, d)); return true;
    case 'ann_fmt': await respond(interaction, viewFormat(nonce, d)); return true;
    case 'ann_fset': {
      const kind = parts[3], v = interaction.values[0], A = announcements;
      if (kind === 'title' && A.TITLE_STYLES[v]) d.format.title = v;
      if (kind === 'bullets' && A.BULLET_STYLES[v]) d.format.bullets = v;
      if (kind === 'colour' && A.COLOUR_CHOICES[v]) d.format.colour = v;
      await respond(interaction, viewFormat(nonce, d));
      return true;
    }
    case 'ann_ffoot': d.format.footer = !d.format.footer; await respond(interaction, viewFormat(nonce, d)); return true;
    case 'ann_freset': d.format = { ...announcements.DEFAULT_FORMAT }; await respond(interaction, viewFormat(nonce, d, 'Back to the defaults.')); return true;
    case 'ann_fwords':
      await interaction.showModal(new ModalBuilder().setCustomId(`owner:ann_wordsmodal:${nonce}`).setTitle('Bold words').addComponents(
        row(new TextInputBuilder().setCustomId('words').setLabel('Words to make bold (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)
          .setValue(d.format.boldWords.join(', ')).setPlaceholder('new, fixed, important'))));
      return true;
    case 'ann_servers': await respond(interaction, viewServers(client, nonce, d, Number(parts[3]) || 0)); return true;
    case 'ann_pg': await respond(interaction, viewServers(client, nonce, d, Number(parts[3]) || 0)); return true;
    case 'ann_pick': {
      const page = Number(parts[3]) || 0;
      const onPage = guildsOf(client).slice(page * PAGE, page * PAGE + PAGE).map(g => g.id);
      for (const id of onPage) d.selected.delete(id);
      for (const id of interaction.values) d.selected.add(id);
      await respond(interaction, viewServers(client, nonce, d, page));
      return true;
    }
    case 'ann_all': {
      const page = Number(parts[3]) || 0;
      for (const g of guildsOf(client)) if (announcementChannel(g).state === 'ok') d.selected.add(g.id);
      await respond(interaction, viewServers(client, nonce, d, page, 'Selected every server that has a working announcement channel.'));
      return true;
    }
    case 'ann_none': d.selected.clear(); d.overrides.clear(); await respond(interaction, viewServers(client, nonce, d, Number(parts[3]) || 0)); return true;
    case 'ann_review': await respond(interaction, viewReview(client, nonce, d)); return true;
    case 'ann_chg': {
      const guild = client.guilds.cache.get(interaction.values[0]);
      await respond(interaction, guild ? viewChannelPick(guild, nonce, d) : viewReview(client, nonce, d));
      return true;
    }
    case 'ann_ch': {
      const guild = client.guilds.cache.get(parts[3]), v = interaction.values[0];
      if (v === '__auto') d.overrides.delete(parts[3]); else d.overrides.set(parts[3], v);
      await respond(interaction, viewReview(client, nonce, d, guild ? `Updated ${guild.name}.` : null));
      return true;
    }
    case 'ann_last': {
      let used = 0;
      for (const g of selectedGuilds(client, d)) { const ch = lastChannel(g); if (ch) { d.overrides.set(g.id, ch.id); used++; } }
      await respond(interaction, viewReview(client, nonce, d, `Using the channels from last time in ${used} server(s).`));
      return true;
    }
    case 'ann_confirm': await respond(interaction, viewConfirm(client, nonce, d)); return true;
    case 'ann_send': {
      drafts.delete(nonce);
      await interaction.update({ content: 'Sending…', embeds: [], components: [] });
      const r = await send(interaction, client, d);
      await interaction.editReply({
        content: [`Sent to **${r.sent}** server(s).`,
          r.skipped.length ? `No channel I could post in (skipped): ${r.skipped.join(', ').slice(0, 600)}` : null,
          r.failed.length ? `Could not post in ${r.failed.length}: ${r.failed.join(', ').slice(0, 600)}` : null].filter(Boolean).join('\n'),
        components: [row(backToSection())],
      });
      return true;
    }
    default: return false;
  }
}

module.exports = { viewHome, viewFormat, handle, _drafts: drafts, _targetFor: targetFor, _announcementChannel: announcementChannel };
