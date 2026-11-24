/**
 * /setup pages for welcome and leave posts (engine: src/welcome.js, settings: src/cards.js).
 *
 *   main      channels, on/off, and the way into each post and the extras
 *   post      one post (welcome or leave): format, style, avatar shape, text, preview
 *   extras    welcome message to the member, roles for new members, "welcome back" text
 *
 * customIds: setup:welcome[:<action>[:<w|l>]]   (w = welcome, l = leave)
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const kit = require('./setupKit');
const cards = require('./cards');
const welcome = require('./welcome');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { audit } = require('./diagnostics');
const { log } = require('./logger');

const { BLUE, chan, role, onOff, noteBad, noteGood, backButton, channelSelect, respond, missingIn, POST_PERMS } = kit;

const PAGES = ['welcome'];
const owns = (page) => PAGES.includes(page);

const TYPE = { w: 'welcome', l: 'leave' };
const NAME = { welcome: 'Welcome', leave: 'Leave' };

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const short = (v, n = 40) => (v ? `\`${v.length > n ? v.slice(0, n - 1) + '…' : v}\`` : '*none*');
const letter = (type) => (type === 'welcome' ? 'w' : 'l');

function summaryOf(guildId, type) {
  const o = cards.options(guildId, type);
  const parts = [cards.FORMATS[o.format].label];
  if (o.card) parts.push(`${cards.STYLES[o.style].label} style`, cards.SHAPES[o.shape].toLowerCase());
  return parts.join(' · ');
}

// ── Main page ─────────────────────────────────────────────────────────────────

function viewMain(guild, user, note) {
  const c = getGuildConfig(guild.id);
  const wOn = c.welcomeEnabled !== false, lOn = c.leaveEnabled !== false;
  const extras = [c.welcomeDm ? 'welcome message on' : null, (c.welcomeRoleIds || []).length ? `${c.welcomeRoleIds.length} join role${c.welcomeRoleIds.length === 1 ? '' : 's'}` : null, c.welcomeBackText ? 'welcome back text' : null].filter(Boolean);

  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Welcome & leave').setDescription([note,
    `**Welcome post** · ${chan(c.welcomeChannelId)} · ${onOff(wOn)}\n${summaryOf(guild.id, 'welcome')}`,
    `**Leave post** · ${chan(c.leaveChannelId || c.welcomeChannelId)}${c.leaveChannelId ? '' : ' *(same channel as welcome)*'} · ${onOff(lOn)}\n${summaryOf(guild.id, 'leave')}`,
    `**Extras** · ${extras.length ? extras.join(', ') : 'none'}`,
    'Pick a channel, then press **Welcome post** or **Leave post** to change how each one looks. Use **Preview** to see exactly what will be posted.',
  ].filter(Boolean).join('\n\n'));

  return {
    embeds: [embed],
    components: [
      channelSelect('setup:welcome:wch', 'Where should welcome posts go?', c.welcomeChannelId),
      channelSelect('setup:welcome:lch', 'Where should leave posts go? (optional)', c.leaveChannelId),
      new ActionRowBuilder().addComponents(
        button('setup:welcome:post:w', 'Welcome post', ButtonStyle.Primary), button('setup:welcome:post:l', 'Leave post', ButtonStyle.Primary),
        button('setup:welcome:extras', 'Extras', ButtonStyle.Primary)),
      new ActionRowBuilder().addComponents(
        button('setup:welcome:tw', `Welcome ${wOn ? 'on' : 'off'}`, wOn ? ButtonStyle.Success : ButtonStyle.Secondary),
        button('setup:welcome:tl', `Leave ${lOn ? 'on' : 'off'}`, lOn ? ButtonStyle.Success : ButtonStyle.Secondary),
        backButton('home', 'Back to setup')),
    ],
  };
}

// ── One post ──────────────────────────────────────────────────────────────────

function viewPost(guild, type, note) {
  const o = cards.options(guild.id, type), L = letter(type);
  const hasEmbed = o.format === 'embed' || o.format === 'both';
  const lines = [note,
    `**Format:** ${cards.FORMATS[o.format].label}`,
    o.card ? `**Card:** ${cards.STYLES[o.style].label} style · ${cards.SHAPES[o.shape].toLowerCase()} avatar · title ${short(o.title)} · subtitle ${short(o.subtitle)}` : null,
    `**Message above:** ${short(o.message, 60)}`,
    hasEmbed ? `**Embed:** title ${short(o.embedTitle)} · text ${short(o.embedText, 50)} · footer ${short(o.embedFooter)} · colour ${o.accent ? `\`${o.accent}\`` : '*default*'}` : null,
    '',
    '**Placeholders:** `{user}` name · `{username}` · `{mention}` · `{server}` · `{count}` · `{ordinal}` (1,204th) · `{accountage}`' + (type === 'leave' ? ' · `{joined}` (how long they were here)' : '') + ' · `{rules}`',
  ];

  const formatMenu = new StringSelectMenuBuilder().setCustomId(`setup:welcome:fmt:${L}`).setPlaceholder('How should it look?')
    .addOptions(Object.entries(cards.FORMATS).map(([value, f]) => ({ label: f.label, value, description: f.desc, default: o.format === value })));
  const styleMenu = new StringSelectMenuBuilder().setCustomId(`setup:welcome:sty:${L}`).setPlaceholder(o.card ? 'Card style' : 'Card style (turn on a format with the card to use it)')
    .setDisabled(!o.card).addOptions(Object.entries(cards.STYLES).map(([value, s]) => ({ label: s.label, value, description: s.desc, default: o.style === value })));

  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`${NAME[type]} post`).setDescription(lines.filter(v => v != null).join('\n'))],
    components: [
      new ActionRowBuilder().addComponents(formatMenu),
      new ActionRowBuilder().addComponents(styleMenu),
      new ActionRowBuilder().addComponents(
        button(`setup:welcome:ct:${L}`, 'Edit message & card'), button(`setup:welcome:et:${L}`, 'Edit embed', ButtonStyle.Secondary, !hasEmbed),
        button(`setup:welcome:shp:${L}`, `Avatar: ${o.shape === 'circle' ? 'circle' : 'rounded'}`, ButtonStyle.Secondary, !o.card),
        button(`setup:welcome:ava:${L}`, `Embed avatar: ${onOff(o.avatar)}`, ButtonStyle.Secondary, !(o.format === 'embed'))),
      new ActionRowBuilder().addComponents(
        button(`setup:welcome:pv:${L}`, 'Preview', ButtonStyle.Success), button(`setup:welcome:rs:${L}`, 'Reset to defaults', ButtonStyle.Danger), backButton('welcome', 'Back')),
    ],
  };
}

function messageModal(guild, type) {
  const o = cards.options(guild.id, type);
  const input = (id, label, style, value, max, placeholder) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(false).setMaxLength(max).setPlaceholder(placeholder).setValue(String(value || '').slice(0, max)));
  return new ModalBuilder().setCustomId(`setup:welcome:ctm:${letter(type)}`).setTitle(`${NAME[type]}: message and card`).addComponents(
    input('message',  'Message above (blank = none)',        TextInputStyle.Paragraph, o.message,  cards.LIMITS.message,  '{mention} welcome to {server}!'),
    input('title',    'Card title',                          TextInputStyle.Short,     o.title,    cards.LIMITS.title,    '{user}'),
    input('subtitle', 'Card subtitle (blank = none)',        TextInputStyle.Short,     o.subtitle, cards.LIMITS.subtitle, 'Member {ordinal}'),
    input('accent',   'Accent colour (hex, blank = default)', TextInputStyle.Short,    o.accent,   7,                     '#5865F2'),
  );
}

function embedModal(guild, type) {
  const o = cards.options(guild.id, type);
  const input = (id, label, style, value, max, placeholder) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(false).setMaxLength(max).setPlaceholder(placeholder).setValue(String(value || '').slice(0, max)));
  return new ModalBuilder().setCustomId(`setup:welcome:etm:${letter(type)}`).setTitle(`${NAME[type]}: embed`).addComponents(
    input('title',  'Embed title',                TextInputStyle.Short,     o.embedTitle,  cards.LIMITS.embedTitle,  'Welcome to {server}!'),
    input('text',   'Embed text',                 TextInputStyle.Paragraph, o.embedText,   cards.LIMITS.embedText,   '{mention} just joined. You are member {ordinal}.'),
    input('footer', 'Footer (blank = none)',      TextInputStyle.Short,     o.embedFooter, cards.LIMITS.embedFooter, 'Account created {accountage} ago'),
  );
}

// ── Extras ────────────────────────────────────────────────────────────────────

function viewExtras(guild, note) {
  const c = getGuildConfig(guild.id);
  const roles = (c.welcomeRoleIds || []).filter(id => guild.roles.cache.has(id));
  const verifying = !!c.verifyRoleId;
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Welcome extras').setDescription([note,
    `**Welcome message to the member:** ${c.welcomeDm ? 'on' : 'off'}${c.welcomeDm ? `\n${short(c.welcomeDmText || cards.DM_DEFAULT, 90)}` : ''}\nA private message sent to each new member. Bots are skipped, and members with closed DMs simply don't get it.`,
    `**Roles for new members:** ${roles.length ? roles.map(role).join(' ') : '*none*'}${verifying ? '\n⚠️ Verification is set up, so these are **not** given: verification decides who gets which role.' : ''}`,
    `**Welcome back text:** ${c.welcomeBackText ? short(c.welcomeBackText, 90) : '*same as a new member*'}\nShown in the welcome post when someone who left before comes back (remembered for 90 days).`,
  ].filter(Boolean).join('\n\n'));

  const roleMenu = new RoleSelectMenuBuilder().setCustomId('setup:welcome:roles').setPlaceholder('Roles to give every new member (optional)').setMinValues(0).setMaxValues(5);
  if (roles.length) roleMenu.setDefaultRoles(...roles);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(roleMenu),
      new ActionRowBuilder().addComponents(
        button('setup:welcome:dm', `Welcome message: ${onOff(c.welcomeDm)}`, c.welcomeDm ? ButtonStyle.Success : ButtonStyle.Secondary),
        button('setup:welcome:dmt', 'Edit welcome message'), button('setup:welcome:bk', 'Edit welcome back text'),
        backButton('welcome', 'Back')),
    ],
  };
}

const dmModal = (guild) => new ModalBuilder().setCustomId('setup:welcome:dmtm').setTitle('Welcome message to the member').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(false)
    .setMaxLength(cards.LIMITS.dm).setPlaceholder(cards.DM_DEFAULT).setValue(String(getGuildConfig(guild.id).welcomeDmText || '').slice(0, cards.LIMITS.dm))));

const backModal = (guild) => new ModalBuilder().setCustomId('setup:welcome:bkm').setTitle('Welcome back text').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Text for returning members (blank = same as new)').setStyle(TextInputStyle.Paragraph).setRequired(false)
    .setMaxLength(cards.LIMITS.embedText).setPlaceholder('Welcome back, {mention}! Good to see you again.').setValue(String(getGuildConfig(guild.id).welcomeBackText || '').slice(0, cards.LIMITS.embedText))));

const VIEWS = { welcome: (guild, user, note) => viewMain(guild, user, note) };

// ── Actions ───────────────────────────────────────────────────────────────────

async function preview(interaction, guild, type) {
  await interaction.deferReply({ flags: kit.ephemeral });
  try {
    const payload = await welcome.buildPost(guild, type, interaction.member, { joinedMs: 3 * 86_400_000 + 4 * 3_600_000, mention: false });
    payload.content = [`**${NAME[type]} preview**, exactly what will be posted:`, payload.content].filter(Boolean).join('\n\n');
    await interaction.editReply(payload);
  } catch (err) {
    log('ERROR', 'Welcome preview failed', { guild: guild.name, err });
    await interaction.editReply({ content: 'Could not generate the preview. The bot owner has been notified.' });
  }
}

async function handle(interaction, { guild, by, action, arg }) {
  const type = TYPE[arg];
  const done = (what, details) => audit({ action: `Setup: welcome and leave, ${what}`, actor: by, guild, details });
  const main = (note) => respond(interaction, viewMain(guild, by, note));
  const post = (note) => respond(interaction, viewPost(guild, type, note));
  const extras = (note) => respond(interaction, viewExtras(guild, note));
  const patch = (obj) => setGuildConfig(guild.id, obj);
  const k = type ? cards.keys(type) : null;

  if (!action) return main();
  if (action === 'post' && type) return post();
  if (action === 'extras') return extras();

  if (action === 'wch' || action === 'lch') {
    await interaction.deferUpdate();
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild, [...POST_PERMS, 'AttachFiles']);
    if (missing.length) return main(noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    patch(action === 'wch' ? { welcomeChannelId: channel.id, welcomeEnabled: true } : { leaveChannelId: channel.id });
    done(action === 'wch' ? 'welcome channel set' : 'leave channel set', `#${channel.name}`);
    return main(noteGood(`${action === 'wch' ? 'Welcome' : 'Leave'} posts go to ${channel}.`));
  }
  if (action === 'tw' || action === 'tl') {
    await interaction.deferUpdate();
    const key = action === 'tw' ? 'welcomeEnabled' : 'leaveEnabled';
    const now = getGuildConfig(guild.id)[key] !== false;
    patch({ [key]: !now });
    done(`${action === 'tw' ? 'welcome' : 'leave'} ${!now ? 'on' : 'off'}`);
    return main();
  }

  // One post
  if (type && action === 'fmt') { await interaction.deferUpdate(); patch({ [k.format]: interaction.values[0], [k.card]: ['card', 'both'].includes(interaction.values[0]) }); done(`${type} format`, interaction.values[0]); return post(noteGood('Saved. Press **Preview** to see it.')); }
  if (type && action === 'sty') { await interaction.deferUpdate(); patch({ [k.style]: interaction.values[0] }); done(`${type} style`, interaction.values[0]); return post(noteGood('Saved. Press **Preview** to see it.')); }
  if (type && action === 'shp') { await interaction.deferUpdate(); patch({ [k.shape]: cards.options(guild.id, type).shape === 'circle' ? 'rounded' : 'circle' }); return post(); }
  if (type && action === 'ava') { await interaction.deferUpdate(); patch({ [k.avatar]: !cards.options(guild.id, type).avatar }); return post(); }
  if (type && action === 'ct') return interaction.showModal(messageModal(guild, type)), true;
  if (type && action === 'et') return interaction.showModal(embedModal(guild, type)), true;
  if (type && action === 'pv') return preview(interaction, guild, type), true;
  if (type && action === 'rs') {
    await interaction.deferUpdate();
    patch(Object.fromEntries(cards.resetKeys(type).map(key => [key, null])));
    done(`${type} reset to defaults`);
    return post(noteGood('Back to the defaults.'));
  }
  if (type && action === 'ctm') {
    const text = (id) => interaction.fields.getTextInputValue(id).trim();
    const rawAccent = text('accent'), accent = rawAccent ? cards.parseColour(rawAccent) : null;
    if (rawAccent && !accent) return post(noteBad('That is not a colour. Use a hex code such as `#5865F2`.'));
    patch({ [k.message]: text('message'), [k.title]: text('title') || null, [k.subtitle]: text('subtitle'), [k.accent]: accent });
    done(`${type} message and card`);
    return post(noteGood('Saved. Press **Preview** to see it.'));
  }
  if (type && action === 'etm') {
    const text = (id) => interaction.fields.getTextInputValue(id).trim();
    patch({ [k.embedTitle]: text('title'), [k.embedText]: text('text'), [k.embedFooter]: text('footer') });
    done(`${type} embed`);
    return post(noteGood('Saved. Press **Preview** to see it.'));
  }

  // Extras
  if (action === 'roles') {
    await interaction.deferUpdate();
    const picked = [...interaction.roles.values()];
    const bad = picked.filter(r => r.managed || r.id === guild.id || !r.editable);
    patch({ welcomeRoleIds: picked.filter(r => !bad.includes(r)).map(r => r.id) });
    done('roles for new members', picked.filter(r => !bad.includes(r)).map(r => r.name).join(', ') || 'none');
    return extras(bad.length ? noteBad(`I can't give ${bad.map(r => r.name).join(', ')}: it is a bot role, @everyone, or above my role. The others were saved.`) : noteGood('Saved.'));
  }
  if (action === 'dm') { await interaction.deferUpdate(); const now = !!getGuildConfig(guild.id).welcomeDm; patch({ welcomeDm: !now }); done('welcome message', !now ? 'on' : 'off'); return extras(); }
  if (action === 'dmt') return interaction.showModal(dmModal(guild)), true;
  if (action === 'bk')  return interaction.showModal(backModal(guild)), true;
  if (action === 'dmtm') { patch({ welcomeDmText: interaction.fields.getTextInputValue('text').trim() || null }); done('welcome message text'); return extras(noteGood('Saved.')); }
  if (action === 'bkm')  { patch({ welcomeBackText: interaction.fields.getTextInputValue('text').trim() || null }); done('welcome back text'); return extras(noteGood('Saved.')); }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
