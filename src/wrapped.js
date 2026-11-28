/**
 * Everything the voice panel shows beyond the live status: busy times, the weekly recap, My Server Time Wrapped and
 * Server Wrapped, plus the December auto-post.
 *
 * Voice numbers come from the voice sessions the bot already keeps. Message and reaction numbers come from the counts in
 * src/activity.js, which only exist for servers that switched counting on, so those cards say when counting began.
 */

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { selectAll } = require('./database');
const activity = require('./activity');
const { duration } = require('./duration');
const { log } = require('./logger');

const DAY = 86_400_000;
const GOLD = 0xFFC857, BLUE = 0x5865F2;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const people = (n) => plural(n, 'person', 'people');
const num = (n) => Number(n || 0).toLocaleString('en-GB');
const dayRange = (a, b) => { const f = (o) => shortDate(new Date(o * DAY).toISOString().slice(0, 10)); return a === b ? f(a) : `${f(a)} to ${f(b)}`; };
const shortDate = (day) => { const [, m, d] = day.split('-').map(Number); return `${d} ${MONTHS[m - 1].slice(0, 3)}`; };
const longDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const tz = require('./timezone');
const hourText = (h, clock) => tz.hourLabel(h, clock);   // the server's own clock, 12 or 24 hour
const dayOrdinal = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
const afkOf = (guild) => guild.afkChannelId || '';
const png = (buf, name) => new AttachmentBuilder(buf, { name });
/** The chart gets its own card: Discord shows each picture at most ~400 high, so one tall card would be shrunk and hard to read. */
const chartCard = (colour, name) => new EmbedBuilder().setColor(colour).setImage(`attachment://${name}`);

// ── Wrapped: the numbers ──────────────────────────────────────────────────────

function voiceRows(guildId, userId, from, to, afk) {
  return selectAll(
    `SELECT user_id, channel_id, channel_name, joined_at, duration_ms FROM vc_sessions
     WHERE guild_id = ? ${userId ? 'AND user_id = ?' : ''} AND COALESCE(summary, 0) = 0 AND duration_ms IS NOT NULL
       AND joined_at >= ? AND joined_at < ? AND channel_id != ?`,
    [guildId, ...(userId ? [userId] : []), from, to, afk]);
}
function streamRows(guildId, userId, from, to) {
  return selectAll(
    `SELECT user_id, duration_ms FROM stream_sessions WHERE guild_id = ? ${userId ? 'AND user_id = ?' : ''} AND duration_ms IS NOT NULL AND joined_at >= ? AND joined_at < ?`,
    [guildId, ...(userId ? [userId] : []), from, to]);
}
function activityRows(guildId, userId, year) {
  return selectAll(
    `SELECT user_id, day, hour, channel_id, messages, reactions FROM activity
     WHERE guild_id = ? ${userId ? 'AND user_id = ?' : ''} AND day >= ? AND day < ?`,
    [guildId, ...(userId ? [userId] : []), `${year}-01-01`, `${year + 1}-01-01`]);
}

/** One person's year, or the whole server's, from voice and activity rows. Pure, so it can be tested. */
function summarise(voice, act, year, zone = 'UTC') {
  const hourShift = Math.round(tz.offsetMs(zone) / 3_600_000);
  const out = {
    messages: 0, reactions: 0, voiceMs: 0, sessions: voice.length, favText: null, favVoice: null, streak: 0, daysActive: 0,
    busiestDay: null, topHour: null, first: null, months: Array.from({ length: 12 }, () => ({ messages: 0, voiceMs: 0 })), people: new Set(),
  };
  const text = new Map(), vc = new Map(), days = new Map(), hours = new Array(24).fill(0);
  const dayEntry = (d) => { if (!days.has(d)) days.set(d, { messages: 0, voiceMs: 0 }); return days.get(d); };

  for (const r of act) {
    out.messages += r.messages; out.reactions += r.reactions; out.people.add(r.user_id);
    text.set(r.channel_id, (text.get(r.channel_id) || 0) + r.messages);
    const e = dayEntry(r.day); e.messages += r.messages;
    out.months[Number(r.day.slice(5, 7)) - 1].messages += r.messages;
    hours[(r.hour + hourShift + 24) % 24] += r.messages;
    if (r.messages > 0 && (!out.first || `${r.day} ${String(r.hour).padStart(2, '0')}` < `${out.first.day} ${String(out.first.hour).padStart(2, '0')}`)) out.first = { day: r.day, hour: r.hour, channelId: r.channel_id };
  }
  for (const v of voice) {
    const ms = Number(v.duration_ms) || 0, d = new Date(tz.local(zone, v.joined_at));
    out.voiceMs += ms; out.people.add(v.user_id);
    const key = v.channel_id; const cur = vc.get(key) || { name: v.channel_name, ms: 0 }; cur.ms += ms; cur.name = v.channel_name; vc.set(key, cur);
    dayEntry(d.toISOString().slice(0, 10)).voiceMs += ms;
    // a call that runs past midnight also counts for the days it carries on into, so a long session cannot break a streak
    for (let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 86_400_000; t <= tz.local(zone, v.joined_at) + ms; t += 86_400_000) dayEntry(new Date(t).toISOString().slice(0, 10));
    out.months[d.getUTCMonth()].voiceMs += ms;
    hours[d.getUTCHours()] += ms / 600_000;
  }
  const top = (m, pick) => { let best = null; for (const [k, v] of m) { const n = pick(v); if (n > 0 && (!best || n > best.n)) best = { id: k, n, v }; } return best; };
  const ft = top(text, (n) => n); if (ft) out.favText = { id: ft.id, messages: ft.n };
  const fv = top(vc, (v) => v.ms); if (fv) out.favVoice = { name: fv.v.name, ms: fv.n };

  out.daysActive = days.size;
  const ordinals = [...days.keys()].map(dayOrdinal).sort((a, b) => a - b);
  let run = 0, prev = null;
  let runStart = null;
  for (const o of ordinals) {
    if (prev !== null && o === prev + 1) run++; else { run = 1; runStart = o; }
    if (run > out.streak) { out.streak = run; out.streakFrom = runStart; out.streakTo = o; }
    prev = o;
  }

  let bestDay = null;
  for (const [d, e] of days) { const score = e.messages + e.voiceMs / 360_000; if (score > 0 && (!bestDay || score > bestDay.score)) bestDay = { day: d, score, ...e }; }
  out.busiestDay = bestDay;
  const topHour = hours.reduce((b, v, h) => (v > b.v ? { h, v } : b), { h: -1, v: 0 });
  out.topHour = topHour.h >= 0 ? topHour.h : null;
  out.hourShare = (from, to) => { const total = hours.reduce((a, b) => a + b, 0); if (!total) return 0; let s = 0; for (let h = from; h < to; h++) s += hours[h]; return s / total; };
  return out;
}

/** A name and a line for how someone used the server this year. */
function persona(s) {
  const hours = s.voiceMs / 3_600_000;
  if (s.daysActive < 5) return { name: 'The Newcomer', line: 'Just getting started. The year is still wide open.' };
  if (s.streak >= 14) return { name: 'The Streak Keeper', line: `${s.streak} days in a row. Hard to beat that.` };
  if (s.messages > 0 && s.messages > hours * 30 && s.messages >= 200) return { name: 'The Chatterbox', line: 'Always something to say, and plenty of people to say it to.' };
  if (hours >= 20 && s.messages < hours * 5) return { name: 'The Voice Regular', line: 'Better heard than read. You live in the voice channels.' };
  if (s.hourShare(0, 5) >= 0.4) return { name: 'The Night Owl', line: 'Most active in the small hours, when the server goes quiet.' };
  if (s.hourShare(5, 10) >= 0.4) return { name: 'The Early Bird', line: 'First one in, most mornings.' };
  return { name: 'The All-Rounder', line: 'A bit of chat, a bit of voice, always around.' };
}

/** The person you spent the most time in the same voice channel as, this year. */
function mostTimeWith(guild, userId, from, to) {
  const now = Date.now();
  const rows = selectAll(
    `WITH a AS (SELECT channel_id, joined_at AS s, joined_at + COALESCE(duration_ms, ? - joined_at) AS e FROM vc_sessions
                WHERE guild_id = ? AND user_id = ? AND COALESCE(summary, 0) = 0 AND joined_at >= ? AND joined_at < ? AND channel_id != ?),
          b AS (SELECT user_id, channel_id, joined_at AS s, joined_at + COALESCE(duration_ms, ? - joined_at) AS e FROM vc_sessions
                WHERE guild_id = ? AND user_id != ? AND COALESCE(summary, 0) = 0 AND joined_at < ? AND channel_id != ?)
     SELECT b.user_id AS user_id, SUM(MAX(0, MIN(a.e, b.e) - MAX(a.s, b.s))) AS ms FROM a JOIN b ON a.channel_id = b.channel_id AND b.s < a.e AND b.e > a.s
     GROUP BY b.user_id ORDER BY ms DESC LIMIT 8`,
    [now, guild.id, userId, from, to, afkOf(guild), now, guild.id, userId, to, afkOf(guild)]);
  for (const r of rows) { const m = guild.members.cache.get(r.user_id); if (m && !m.user.bot && r.ms > 0) return { id: r.user_id, ms: Number(r.ms) }; }
  return null;
}

// ── Wrapped: the cards ────────────────────────────────────────────────────────

const countedNote = (guild) => {
  const s = activity.settings(guild.id);
  return s.counting && s.countingSince ? `Messages and reactions counted since ${longDate(s.countingSince)}` : null;
};
const channelText = (guild, id) => (guild.channels.cache.has(id) ? `<#${id}>` : 'a deleted channel');

function monthValues(s) { return s.months.map(m => m.messages + m.voiceMs / 360_000); }

async function memberWrapped(guild, member, year = new Date().getUTCFullYear()) {
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const counting = activity.settings(guild.id).countingSince != null;
  const zone = tz.zoneOf(guild.id), clock = tz.clockOf(guild.id);
  const s = summarise(voiceRows(guild.id, member.id, from, to, afkOf(guild)), counting ? activityRows(guild.id, member.id, year) : [], year, zone);
  const embed = new EmbedBuilder().setColor(GOLD).setAuthor({ name: `${guild.name} · ${year}` }).setTitle('My Server Time Wrapped');
  if (!s.daysActive && !s.voiceMs) {
    return { embeds: [embed.setDescription(`Nothing to show yet for ${year}. Spend some time in voice${counting ? ' or chat' : ''} and check back.`)], files: [] };
  }
  const p = persona(s), fields = [];
  if (counting) fields.push({ name: 'Messages sent', value: num(s.messages), inline: true }, { name: 'Reactions given', value: num(s.reactions), inline: true });
  fields.push({ name: 'Time in voice', value: duration(s.voiceMs), inline: true });
  if (s.favText) fields.push({ name: 'Top text channel', value: channelText(guild, s.favText.id), inline: true });
  if (s.favVoice) fields.push({ name: 'Top voice channel', value: s.favVoice.name, inline: true });
  fields.push({ name: 'Longest streak', value: s.streak > 1 ? `${plural(s.streak, 'day')}\n${dayRange(s.streakFrom, s.streakTo)}` : plural(s.streak, 'day'), inline: true });
  if (s.busiestDay) fields.push({ name: 'Busiest day', value: `${shortDate(s.busiestDay.day)}${s.busiestDay.voiceMs > 0 ? `\n${duration(s.busiestDay.voiceMs)} in voice` : ''}`, inline: true });
  const streams = streamRows(guild.id, member.id, from, to), streamMs = streams.reduce((a, r) => a + Number(r.duration_ms), 0);
  if (streamMs > 0) fields.push({ name: 'Time streaming', value: `${duration(streamMs)}\n${plural(streams.length, 'stream')}`, inline: true });
  if (s.topHour != null) fields.push({ name: 'Most active hour', value: hourText(s.topHour, clock), inline: true });
  fields.push({ name: 'Days active', value: num(s.daysActive), inline: true });
  if (s.first) fields.push({ name: 'First message', value: `${shortDate(s.first.day)} in ${channelText(guild, s.first.channelId)}`, inline: true });
  const mw = mostTimeWith(guild, member.id, from, to);
  if (mw) fields.push({ name: 'Most time with', value: `<@${mw.id}>\n${duration(mw.ms)} together`, inline: true });

  const note = countedNote(guild);
  embed.setDescription(`**${p.name}**\n${p.line}`).addFields(fields).setThumbnail(member.displayAvatarURL({ extension: 'png', size: 128 }));
  if (note) embed.setFooter({ text: note });
  const chart = await require('./ui/charts').monthChart(monthValues(s), 'ACTIVITY BY MONTH', year === new Date().getUTCFullYear() ? new Date().getUTCMonth() : -1);
  return { embeds: [embed, chartCard(GOLD, 'wrapped-months.png')], files: [png(chart, 'wrapped-months.png')] };
}

async function serverWrapped(guild, year = new Date().getUTCFullYear()) {
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const counting = activity.settings(guild.id).countingSince != null;
  const voice = voiceRows(guild.id, null, from, to, afkOf(guild)), act = counting ? activityRows(guild.id, null, year) : [];
  const zone = tz.zoneOf(guild.id), clock = tz.clockOf(guild.id);
  const s = summarise(voice, act, year, zone);
  const embed = new EmbedBuilder().setColor(GOLD).setAuthor({ name: `${guild.name} · ${year}` }).setTitle('Server Wrapped');
  if (!s.daysActive && !s.voiceMs) return { embeds: [embed.setDescription(`Nothing to show yet for ${year}.`)], files: [] };

  const sumBy = (rows, key, val) => { const m = new Map(); for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + Number(r[val] || 0)); return [...m].sort((a, b) => b[1] - a[1]); };
  const present = (id) => { const m = guild.members.cache.get(id); return m && !m.user.bot; };
  const topVoice = sumBy(voice, 'user_id', 'duration_ms').filter(([id]) => present(id)).slice(0, 3);
  const topChat = sumBy(act, 'user_id', 'messages').filter(([id, n]) => present(id) && n > 0).slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  const busiestMonth = s.months.map((m, i) => ({ i, v: m.messages + m.voiceMs / 360_000 })).sort((a, b) => b.v - a.v)[0];

  const fields = [];
  if (counting) fields.push({ name: 'Messages sent', value: num(s.messages), inline: true });
  fields.push({ name: 'Time in voice', value: duration(s.voiceMs), inline: true }, { name: 'Active members', value: num([...s.people].filter(present).length), inline: true });
  if (s.favText) fields.push({ name: 'Top text channel', value: channelText(guild, s.favText.id), inline: true });
  if (s.favVoice) fields.push({ name: 'Top voice channel', value: s.favVoice.name, inline: true });
  if (s.busiestDay) fields.push({ name: 'Busiest day', value: shortDate(s.busiestDay.day), inline: true });
  if (busiestMonth?.v > 0) fields.push({ name: 'Busiest month', value: MONTHS[busiestMonth.i], inline: true });
  if (s.topHour != null) fields.push({ name: 'Busiest hour', value: hourText(s.topHour, clock), inline: true });
  const topStream = sumBy(streamRows(guild.id, null, from, to), 'user_id', 'duration_ms').filter(([id, ms]) => present(id) && ms > 0).slice(0, 3);
  if (topStream.length) fields.push({ name: 'Most time streaming', value: topStream.map(([id, ms], i) => `${medals[i]} <@${id}>\n${duration(ms)}`).join('\n'), inline: true });
  if (topVoice.length) fields.push({ name: 'Most time in voice', value: topVoice.map(([id, ms], i) => `${medals[i]} <@${id}>\n${duration(ms)}`).join('\n'), inline: true });
  if (topChat.length) fields.push({ name: 'Most messages', value: topChat.map(([id, n], i) => `${medals[i]} <@${id}>\n${plural(n, 'message')}`).join('\n'), inline: true });

  embed.setDescription(`A look back at ${year} in **${guild.name}**.\nMembers can open their own with the button below.`).addFields(fields);
  const note = countedNote(guild); if (note) embed.setFooter({ text: note });
  const chart = await require('./ui/charts').monthChart(monthValues(s), 'SERVER ACTIVITY BY MONTH', year === new Date().getUTCFullYear() ? new Date().getUTCMonth() : -1);
  return { embeds: [embed, chartCard(GOLD, 'wrapped-months.png')], files: [png(chart, 'wrapped-months.png')] };
}

const wrappedButtons = () => [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bot_mywrapped').setLabel('My Server Time Wrapped').setStyle(ButtonStyle.Primary))];

// ── Busy times ────────────────────────────────────────────────────────────────

/** Minutes of voice per UTC day and hour over the last `days` days, from the voice sessions. */
function hourlyMinutes(guild, days = 28, now = Date.now(), zone = 'UTC') {
  const from = now - days * DAY;
  const sessions = selectAll(
    `SELECT joined_at, duration_ms FROM vc_sessions WHERE guild_id = ? AND COALESCE(summary, 0) = 0 AND channel_id != ?
       AND joined_at + COALESCE(duration_ms, ? - joined_at) > ? AND joined_at < ?`, [guild.id, afkOf(guild), now, from, now]);
  const by = new Map();
  for (const s of sessions) {
    const end = Math.min(now, s.joined_at + (s.duration_ms ?? now - s.joined_at));
    for (let t = Math.max(s.joined_at, from); t < end;) {
      const next = Math.min(end, (Math.floor(t / 3_600_000) + 1) * 3_600_000), d = new Date(tz.local(zone, t));
      const key = d.toISOString().slice(0, 10);
      if (!by.has(key)) by.set(key, new Array(24).fill(0));
      by.get(key)[d.getUTCHours()] += (next - t) / 60_000;
      t = next;
    }
  }
  return by;
}

/** What is usual for each weekday and hour: per weekday, the average people in voice at every hour, from the last four weeks. */
function usualBusy(by, now = Date.now(), zone = 'UTC') {
  const today = new Date(tz.local(zone, now)).toISOString().slice(0, 10), samples = Array.from({ length: 7 }, () => []);
  for (let i = 1; i <= 28; i++) {
    const t = now - i * DAY, key = new Date(tz.local(zone, t)).toISOString().slice(0, 10);
    if (key === today) continue;
    samples[new Date(tz.local(zone, t)).getUTCDay()].push((by.get(key) || new Array(24).fill(0)).map(m => m / 60));
  }
  return samples;   // samples[weekday] = list of 24-hour arrays (people in voice on average, per hour)
}

async function busyTimes(guild, now = Date.now()) {
  const embed = new EmbedBuilder().setColor(BLUE).setAuthor({ name: guild.name }).setTitle('Busy times');
  const zone = tz.zoneOf(guild.id), clock = tz.clockOf(guild.id), by = hourlyMinutes(guild, 28, now, zone);
  const total = [...by.values()].reduce((a, d) => a + d.reduce((x, y) => x + y, 0), 0);
  const nowIn = [...guild.voiceStates.cache.values()].filter(v => v.channelId && v.channelId !== afkOf(guild) && v.member && !v.member.user.bot).length;
  if (total < 120) return { embeds: [embed.setDescription(`Right now **${people(nowIn)}** in voice.\n\nNot enough voice history yet to show what is usual. Check back after a few days.`)], files: [] };

  const d = new Date(tz.local(zone, now)), dow = d.getUTCDay(), hour = d.getUTCHours();
  const samples = usualBusy(by, now, zone);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const usualToday = samples[dow], perHour = Array.from({ length: 24 }, (_, h) => mean(usualToday.map(a => a[h])));
  const vals = usualToday.map(a => a[hour]);
  const lo = Math.round(Math.min(...vals, Infinity)), hi = Math.round(Math.max(...vals, 0));
  const usually = !vals.length || hi === 0 ? 'Usually quiet' : lo === hi ? `About ${people(hi)}` : `${lo} to ${hi} people`;

  let best = { v: 0, dow: 0, h: 0 };
  samples.forEach((list, wd) => { for (let h = 0; h < 24; h++) { const v = mean(list.map(a => a[h])); if (v > best.v) best = { v, dow: wd, h }; } });
  const peakToday = perHour.reduce((b, v, h) => (v > b.v ? { v, h } : b), { v: 0, h: 0 });

  embed.setDescription(`Right now **${people(nowIn)}** in voice.`).addFields(
    { name: 'Usually then', value: usually, inline: true },
    { name: 'Peak today', value: peakToday.v >= 0.5 ? `${hourText(peakToday.h, clock)}\nAbout ${people(Math.round(peakToday.v))}` : 'No clear peak', inline: true },
    { name: 'Peak of the week', value: best.v >= 0.5 ? `${DAYS[best.dow]}s ${hourText(best.h, clock)}\nAbout ${people(Math.round(best.v))}` : 'No clear peak', inline: true },
  ).setFooter({ text: `From the last four weeks.` });
  const chart = await require('./ui/charts').busyChart(perHour, hour, '', '');
  return { embeds: [embed, chartCard(BLUE, 'busy-times.png')], files: [png(chart, 'busy-times.png')] };
}

// ── Weekly recap ──────────────────────────────────────────────────────────────

async function weeklyRecap(guild, viewerId = null, now = Date.now()) {
  const from = now - 7 * DAY;
  const sessions = selectAll(
    `SELECT user_id, joined_at, COALESCE(duration_ms, ? - joined_at) AS ms FROM vc_sessions
     WHERE guild_id = ? AND COALESCE(summary, 0) = 0 AND channel_id != ? AND joined_at >= ?`, [now, guild.id, afkOf(guild), from]);
  const embed = new EmbedBuilder().setColor(BLUE).setAuthor({ name: guild.name }).setTitle('Weekly recap').setFooter({ text: 'The last 7 days' });
  const present = (id) => { const m = guild.members.cache.get(id); return m && !m.user.bot; };
  const rows = sessions.filter(s => present(s.user_id));
  if (!rows.length) return { embeds: [embed.setDescription('No voice time in the last 7 days.')], files: [] };

  const perUser = new Map(), perDay = new Map();
  let longest = 0;
  for (const s of rows) {
    perUser.set(s.user_id, (perUser.get(s.user_id) || 0) + s.ms);
    const key = new Date(s.joined_at).toISOString().slice(0, 10); perDay.set(key, (perDay.get(key) || 0) + s.ms);
    longest = Math.max(longest, s.ms);
  }
  const ranked = [...perUser].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, [, v]) => a + v, 0);
  const [busyDay] = [...perDay].sort((a, b) => b[1] - a[1]);
  const medals = ['🥇', '🥈', '🥉'];

  const fields = [
    { name: 'Time in voice', value: duration(total), inline: true },
    { name: 'People', value: num(ranked.length), inline: true },
    { name: 'Longest call', value: duration(longest), inline: true },
    { name: 'Busiest day', value: DAYS[new Date(`${busyDay[0]}T00:00:00Z`).getUTCDay()], inline: true },
  ];
  if (activity.counting(guild.id)) {
    const since = new Date(from).toISOString().slice(0, 10);
    const act = selectAll('SELECT user_id, SUM(messages) AS n FROM activity WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY n DESC LIMIT 10', [guild.id, since]).filter(r => present(r.user_id) && r.n > 0);
    if (act.length) {
      fields.push({ name: 'Messages', value: num(act.reduce((a, r) => a + Number(r.n), 0)), inline: true });
      fields.push({ name: 'Top chatter', value: `<@${act[0].user_id}>`, inline: true });
    }
  }
  fields.push({ name: 'Most time in voice', value: ranked.slice(0, 3).map(([id, ms], i) => `${medals[i]} <@${id}>\n${duration(ms)}`).join('\n'), inline: false });
  if (viewerId) {
    const at = ranked.findIndex(([id]) => id === viewerId);
    fields.push({ name: 'Your week', value: at >= 0 ? `#${at + 1} · ${duration(ranked[at][1])}` : 'No voice time this week', inline: false });
  }
  return { embeds: [embed.addFields(fields)], files: [] };
}

// ── December auto-post ────────────────────────────────────────────────────────

const POST_HOUR_UTC = 9;

/** Post Server Wrapped in servers that asked for it, on their chosen December day (or the first check after it). */
async function postDue(client, now = new Date()) {
  if (now.getUTCMonth() !== 11 || now.getUTCHours() < POST_HOUR_UTC) return 0;
  const year = now.getUTCFullYear();
  let posted = 0;
  for (const guild of client.guilds.cache.values()) {
    const s = activity.settings(guild.id);
    if (!s.autoPost || !s.channelId || s.postedYear === year || now.getUTCDate() < (s.day || 1)) continue;
    try {
      const channel = await guild.channels.fetch(s.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;
      await post(channel, { ...(await serverWrapped(guild, year)), components: wrappedButtons() });
      activity.setSettings(guild.id, { postedYear: year });
      posted++;
      log('INFO', 'Server Wrapped posted', { guild: guild.name, channel: channel.name });
    } catch (err) { log('WARN', 'Could not post Server Wrapped', { guild: guild.name, err }); }
  }
  return posted;
}

function start(client) {
  const timer = setInterval(() => postDue(client).catch(err => log('WARN', 'Wrapped check failed', { err })), 3_600_000);
  timer.unref?.();
  setTimeout(() => postDue(client).catch(() => {}), 60_000).unref?.();
}

/**
 * A view with a stats card and a chart card is sent as separate messages: when two pictures share one message Discord puts
 * them side by side and crops both. The buttons (if any) go on the last message.
 */
function parts(view) {
  const embeds = view.embeds || [];
  if (embeds.length < 2) return [{ ...view, showpiece: true }];
  const { components, ...rest } = view;
  return embeds.map((e, i) => ({ ...rest, showpiece: true, embeds: [e], files: i === 0 ? [] : view.files, ...(i === embeds.length - 1 && components ? { components } : {}) }));
}
/** Answer an interaction with a view, as one message per card. */
async function reply(interaction, view) {
  const list = parts(view);
  await interaction.editReply(list[0]);
  for (const p of list.slice(1)) await interaction.followUp({ ...p, flags: 64 });
}
/** Post a view in a channel, as one message per card. */
async function post(channel, view) {
  let last;
  for (const p of parts(view)) last = await channel.send(p);
  return last;
}

module.exports = { reply, post, parts, summarise, persona, memberWrapped, serverWrapped, wrappedButtons, busyTimes, hourlyMinutes, usualBusy, weeklyRecap, postDue, start, mostTimeWith };
