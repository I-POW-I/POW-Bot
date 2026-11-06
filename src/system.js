/**
 * One source of truth for "how is the bot doing" — used by the panel, /botinfo,
 * /owner status, the hourly digest and the memory auto-restart, so every number
 * agrees everywhere.
 *
 * RAM: when the Discloud API is configured, RAM is Discloud's own reading (exactly what
 * its dashboard shows, and what the limit is enforced against). Otherwise it falls back
 * to this process's RSS. The old panel figure was Node heap only, which under-reports.
 */

const { monitorEventLoopDelay } = require('perf_hooks');
const discloud = require('./discloud');

const REFRESH_MS = 30_000;
const STALE_MS   = 2 * 60_000;

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let cache = { at: 0, status: null, info: null, error: null };
let timer = null;
const cpu = { last: process.cpuUsage(), at: Date.now(), pct: 0 };

const mb = (bytes) => bytes / 1024 / 1024;
const UNIT_MB = { KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024 };

/** "58.3MB/100MB" → { usedMb: 58.3, limitMb: 100 }   ("58.3 MB" → limitMb null) */
function parseMemoryString(str) {
  const text = String(str ?? '');
  const re   = /([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB)?\s*(?:\/\s*([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB)?)?/i;
  const m    = re.exec(text);
  if (!m || !isFinite(parseFloat(m[1]))) return null;
  const unitA = (m[2] || m[4] || 'MB').toUpperCase();
  const unitB = (m[4] || m[2] || 'MB').toUpperCase();
  return {
    usedMb:  parseFloat(m[1]) * (UNIT_MB[unitA] ?? 1),
    limitMb: m[3] ? parseFloat(m[3]) * (UNIT_MB[unitB] ?? 1) : null,
  };
}

async function refreshDiscloud() {
  if (!discloud.isConfigured()) return cache;
  const [status, info] = await Promise.allSettled([discloud.getStatus(), discloud.getInfo()]);
  cache = {
    at:     Date.now(),
    status: status.status === 'fulfilled' ? status.value : cache.status,
    info:   info.status   === 'fulfilled' ? info.value   : cache.info,
    error:  status.status === 'rejected' ? status.reason.message : (info.status === 'rejected' ? info.reason.message : null),
  };
  return cache;
}

/** Keep the Discloud reading fresh in the background (so sync callers can use it). */
function start() {
  if (timer || !discloud.isConfigured()) return;
  refreshDiscloud().catch(() => {});
  timer = setInterval(() => refreshDiscloud().catch(() => {}), REFRESH_MS);
  timer.unref?.();
}

function stop() { clearInterval(timer); timer = null; }

function getMemoryInfo() {
  const m = process.memoryUsage();
  const out = {
    usedMb: mb(m.rss), limitMb: null, percent: null, source: 'process',
    rssMb: mb(m.rss), heapMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers),
  };

  const fresh = cache.status && Date.now() - cache.at < STALE_MS;
  const parsed = fresh && cache.status.memory ? parseMemoryString(cache.status.memory) : null;
  if (parsed) { out.usedMb = parsed.usedMb; out.limitMb = parsed.limitMb; out.source = 'discloud'; }

  if (out.limitMb == null) {
    const allocated = Number(cache.info?.ram) || Number(process.env.DISCLOUD_RAM_MB) || null;
    out.limitMb = allocated;
  }
  if (out.limitMb) out.percent = (out.usedMb / out.limitMb) * 100;
  return out;
}

/** "148 MB / 200 MB (74%)" — or just "148 MB" when the limit is unknown. */
function formatMemory(m = getMemoryInfo()) {
  const used = `${Math.round(m.usedMb)} MB`;
  return m.limitMb ? `${used} / ${Math.round(m.limitMb)} MB (${Math.round(m.percent)}%)` : used;
}

function sampleCpu() {
  const now = Date.now();
  const elapsedMs = now - cpu.at;
  if (elapsedMs >= 2000) {
    const d = process.cpuUsage(cpu.last);
    cpu.pct  = ((d.user + d.system) / 1000 / elapsedMs) * 100;
    cpu.last = process.cpuUsage();
    cpu.at   = now;
  }
  return cpu.pct;
}

async function getSnapshot({ force = false } = {}) {
  if (discloud.isConfigured() && (force || Date.now() - cache.at > REFRESH_MS)) await refreshDiscloud();

  const s = cache.status || {}, i = cache.info || {};
  const snap = {
    memory:      getMemoryInfo(),
    cpuPercent:  sampleCpu(),
    loop:        { meanMs: loop.mean / 1e6 || 0, p99Ms: loop.percentile(99) / 1e6 || 0, maxMs: loop.max / 1e6 || 0 },
    uptimeSec:   process.uptime(),
    node:        process.version,
    discordjs:   require('discord.js').version,
    platform:    `${process.platform} ${process.arch}`,
    discloud: {
      configured:  discloud.isConfigured(),
      error:       cache.error,
      container:   s.container ?? null,
      cpu:         s.cpu ?? null,
      memory:      s.memory ?? null,
      ssd:         s.ssd ?? null,
      net:         s.netIO ? `↑ ${s.netIO.up ?? '?'} / ↓ ${s.netIO.down ?? '?'}` : null,
      lastRestart: s.last_restart ?? null,
      startedAt:   s.startedAt ?? null,
      online:      i.online ?? null,
      ramKilled:   i.ramKilled ?? null,
      exitCode:    i.exitCode ?? null,
      allocatedMb: Number(i.ram) || null,
    },
  };
  loop.reset();
  return snap;
}

/** Test helper */
function _setCache(c) { cache = { at: Date.now(), error: null, status: null, info: null, ...c }; }

module.exports = { getCpuPercent: () => sampleCpu(), start, stop, refreshDiscloud, getMemoryInfo, formatMemory, parseMemoryString, getSnapshot, _setCache };
