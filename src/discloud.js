/**
 * Discloud API client — https://api.discloud.app/v2
 *
 * Needs two Discloud variables:
 *   DISCLOUD_API_TOKEN  your Discloud API token (Discloud dashboard → API)
 *   DISCLOUD_APP_ID     the ID of this application
 *
 * The token is only ever sent to the Discloud API and is scrubbed from alerts.
 */

const baseUrl = () => process.env.DISCLOUD_API_URL || 'https://api.discloud.app/v2';
const token   = () => (process.env.DISCLOUD_API_TOKEN || '').trim();
const appId   = () => (process.env.DISCLOUD_APP_ID || '').trim();

const isConfigured = () => !!(token() && appId());

async function request(method, path) {
  if (!isConfigured()) throw new Error('Discloud API not configured — set DISCLOUD_API_TOKEN and DISCLOUD_APP_ID');

  const res = await fetch(`${baseUrl()}/app/${encodeURIComponent(appId())}${path}`, {
    method,
    headers: { 'api-token': token(), 'Accept': 'application/json' },
    signal:  AbortSignal.timeout(15_000),
  });

  let data = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }

  if (!res.ok) {
    const detail = data?.message || data?.status || '';
    throw new Error(`Discloud API ${method} ${path || '/'} returned ${res.status}${detail ? ` (${detail})` : ''}`);
  }
  return data;
}

const unwrap = (body) => body?.apps ?? body?.app ?? body ?? {};

/** Live container stats: container, cpu, memory ("used / limit"), ssd, netIO, last_restart, startedAt. */
async function getStatus() { return unwrap(await request('GET', '/status')); }

/** App details: online, ramKilled, exitCode, ram (allocated), … */
async function getInfo()   { return unwrap(await request('GET', '')); }

/** Console output: { big (full), small (recent), url (view online) }. */
async function getLogs() {
  const apps = unwrap(await request('GET', '/logs'));
  const t = apps.terminal || apps;
  return { big: String(t.big ?? ''), small: String(t.small ?? ''), url: t.url || null };
}

/** Restart the whole container. The bot goes offline while this runs. */
async function restart() { return request('PUT', '/restart'); }

module.exports = { isConfigured, getStatus, getInfo, getLogs, restart };
