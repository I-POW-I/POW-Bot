/**
 * Tiny RSS 2.0 / Atom reader — no dependencies.
 * parseFeed(xml) → { title, items: [{ id, title, url, date, content, image }] } (newest first)
 */

const { decode } = require('./format');

const unwrap = (s) => decode(String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
const raw    = (s) => String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : null;
}
function attr(block, name, attrName, filter) {
  const re = new RegExp(`<${name}\\b([^>]*)/?>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    if (filter && !filter(m[1])) continue;
    const a = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(m[1]);
    if (a) return decode(a[1]);
  }
  return null;
}

function parseFeed(xml) {
  const text = String(xml || '');
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) throw new Error('That URL is not an RSS or Atom feed.');

  const head = text.split(/<(?:item|entry)\b/i)[0];
  const feedTitle = unwrap(tag(head, 'title') || '') || null;
  const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  const items = blocks.map((b) => {
    const title = unwrap(tag(b, 'title') || '');
    const link  = tag(b, 'link');
    const url   = (link && unwrap(link)) || attr(b, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)) || null;
    const dateS = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const date  = dateS ? Date.parse(unwrap(dateS)) : NaN;
    const content = raw(tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary') || '');
    const idS   = tag(b, 'guid') || tag(b, 'id');
    const image = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url')
      || attr(b, 'enclosure', 'url', (a) => /type\s*=\s*["']image/i.test(a))
      || (/<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(decode(content)) || [])[1] || null;
    return { id: (idS && unwrap(idS)) || url || title, title, url, date: isNaN(date) ? null : date, content, image };
  }).filter(i => i.title || i.content);

  items.sort((a, b) => (b.date || 0) - (a.date || 0));      // keeps feed order for undated feeds (stable sort)
  return { title: feedTitle, items };
}

module.exports = { parseFeed };
