/**
 * How much the bot is used: commands, buttons and errors per day for the last 30 days, and which commands are popular.
 * Counts only, never who or where. Kept in the bot's own settings file so a restart does not lose it.
 */

const globalConfig = require('./globalConfig');

const DAYS = 30;
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

let pending = null, timer = null;
/** Counts are added in memory and written at most every 30 seconds. */
function flush() {
  timer = null;
  if (!pending) return;
  const add = pending; pending = null;
  globalConfig.update(s => {
    s.usage = s.usage || {};
    const d = s.usage[add.day] = s.usage[add.day] || { commands: 0, buttons: 0, errors: 0, by: {} };
    d.commands += add.commands; d.buttons += add.buttons; d.errors += add.errors;
    for (const [k, v] of Object.entries(add.by)) d.by[k] = (d.by[k] || 0) + v;
    const keep = Object.keys(s.usage).sort().slice(-DAYS);
    for (const k of Object.keys(s.usage)) if (!keep.includes(k)) delete s.usage[k];
  });
}

function record(kind, name) {
  const day = dayKey();
  if (pending && pending.day !== day) flush();
  pending = pending || { day, commands: 0, buttons: 0, errors: 0, by: {} };
  if (kind in pending) pending[kind]++;
  if (kind === 'commands' && name) pending.by[String(name).slice(0, 40)] = (pending.by[String(name).slice(0, 40)] || 0) + 1;
  if (!timer) { timer = setTimeout(flush, 30_000); timer.unref?.(); }
}

/** Totals for the last `days` days, the top commands, and one number per day (oldest first). */
function summary(days = DAYS) {
  flush();
  const usage = globalConfig.get().usage || {};
  const keys = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86_400_000));
  const total = { commands: 0, buttons: 0, errors: 0 }, by = {}, perDay = [];
  for (const k of keys) {
    const d = usage[k] || { commands: 0, buttons: 0, errors: 0, by: {} };
    total.commands += d.commands; total.buttons += d.buttons; total.errors += d.errors;
    for (const [n, v] of Object.entries(d.by || {})) by[n] = (by[n] || 0) + v;
    perDay.push({ day: k, uses: d.commands + d.buttons, errors: d.errors });
  }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { total, top, perDay };
}

module.exports = { record, summary, flush, dayKey };
