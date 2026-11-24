/**
 * Lengths of time, written the way people say them: "1 day 10 minutes", "5 hours 20 minutes".
 * Zero units are left out. Use { seconds: true } for short live timers and { short: true } where space is tight
 * (the bot's status line), which gives "1d 1h 10m".
 */

const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function parts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(total / 86400), h: Math.floor((total % 86400) / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

function duration(ms, { seconds = false, short = false } = {}) {
  const { d, h, m, s } = parts(ms);
  const showSeconds = seconds && !d && (s || !(h || m));
  if (short) {
    const out = [d && `${d}d`, h && `${h}h`, m && `${m}m`, showSeconds && `${s}s`].filter(Boolean);
    return out.length ? out.join(' ') : '0m';
  }
  const out = [d && unit(d, 'day'), h && unit(h, 'hour'), m && unit(m, 'minute'), showSeconds && unit(s, 'second')].filter(Boolean);
  return out.length ? out.join(' ') : 'less than a minute';
}

/** How old an account or membership is, in the unit people use: "3 days", "5 months", "2 years 3 months". */
function age(ms) {
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days < 30) return days < 1 ? duration(ms) : unit(days, 'day');
  const months = Math.floor(days / 30.44);
  if (months < 12) return unit(months, 'month');
  const y = Math.floor(months / 12), m = months % 12;
  return m ? `${unit(y, 'year')} ${unit(m, 'month')}` : unit(y, 'year');
}

module.exports = { duration, age };
