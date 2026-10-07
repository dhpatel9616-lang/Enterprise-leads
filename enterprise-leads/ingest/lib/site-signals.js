// Free, no-AI details read from a business's own homepage, used to make the
// first email specific: the owner's first name (for "Hi Maria,"), an old
// copyright year (a concrete, checkable sign the site is neglected), and a
// "website by <agency>" credit (they already pay someone; lower priority),
// and whether the site really loads over https and has a phone layout (the
// listing's http:// link alone said nothing: most of those sites redirect).
// Precision over recall: when unsure, return null and the email stays generic.

const NOT_NAMES = new Set(('our the meet about contact home welcome services team staff us your we call book ' +
  'location locations hours menu dr mr mrs ms request free get new best family local professional').split(' '));
const PLATFORMS = /^(wordpress|wix|squarespace|godaddy|shopify|weebly|duda|webflow|google|yola|jimdo)\b/i;

function visibleText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&copy;|&#169;/g, '©')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function ownerFirstName(text) {
  const patterns = [
    /\b([A-Z][a-z]{2,15}) [A-Z][a-z]{2,20},? (?:is the |our )?(?:[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]roprietor|[Pp]rincipal|[Pp]resident)\b/,
    /\b(?:[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]roprietor|[Pp]rincipal|[Pp]resident)[:,\s-]+([A-Z][a-z]{2,15}) [A-Z][a-z]{2,20}\b/,
    /\bMeet ([A-Z][a-z]{2,15})(?: [A-Z][a-z]{2,20})?,? (?:the |our )?(?:[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]roprietor|[Pp]rincipal|[Pp]resident)\b/,
    /\b[Ff]ounded (?:in \d{4} )?by ([A-Z][a-z]{2,15}) [A-Z][a-z]{2,20}\b/,
    /\b([A-Z][a-z]{2,15}) [A-Z][a-z]{2,20}, (?:DDS|DMD|DVM|DC|DPT|CPA|Esq\.?)\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && !NOT_NAMES.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}

function copyrightYear(text, nowYear) {
  const years = [...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  const year = years.length ? Math.max(...years) : null;
  return year && year >= 1995 && year <= nowYear ? year : null;
}

function builtBy(text) {
  const m = text.match(/\b(?:[Ww]ebsite|[Ss]ite|[Ww]eb [Dd]esign|[Dd]esigned|[Dd]eveloped|[Bb]uilt|[Pp]owered)\s+(?:and hosted\s+)?[Bb]y:?\s+([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,4})/);
  if (!m || PLATFORMS.test(m[1])) return null;
  return m[1].trim();
}

function signalsFromHtml(html, nowYear = new Date().getFullYear()) {
  html = html || '';
  const text = visibleText(html);
  return {
    ownerFirst: ownerFirstName(text), copyrightYear: copyrightYear(text, nowYear), builtBy: builtBy(text),
    hasTel: /href=["']tel:/i.test(html), // a tap-to-call link
    hasDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html)
      || /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(html),
  };
}

// Google's free PageSpeed test (mobile): seconds until the main content shows
// (Largest Contentful Paint). null when the test can't run. Slow (~15 s), so
// callers only use it when nothing cheaper was found. PSI_API_KEY is optional.
async function pageSpeed(url, timeoutMs = 60000) {
  const key = process.env.PSI_API_KEY ? `&key=${process.env.PSI_API_KEY}` : '';
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=${encodeURIComponent(url)}${key}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const ms = (await res.json()).lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue;
    return typeof ms === 'number' ? ms / 1000 : null;
  } catch {
    return null;
  }
}

const NONE = { ownerFirst: null, copyrightYear: null, builtBy: null, hasTel: null, hasDescription: null, reachable: false, secure: null, mobileOk: null };

async function load(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WadeCapitalBot/1.0)' } });
  if (!res.ok) throw new Error(String(res.status));
  return { finalUrl: res.url, html: await res.text() };
}

async function fetchSignals(url, timeoutMs = 8000) {
  if (!url) return NONE;
  let page;
  try {
    page = await load(url.replace(/^http:/i, 'https:'), timeoutMs);
  } catch {
    try { page = await load(url, timeoutMs); } catch { return NONE; }
  }
  return {
    ...signalsFromHtml(page.html),
    reachable: true,
    secure: page.finalUrl.startsWith('https:'),
    mobileOk: /<meta[^>]+name=["']viewport["']/i.test(page.html),
  };
}

module.exports = { signalsFromHtml, fetchSignals, pageSpeed };

// Self-check: node ingest/lib/site-signals.js
if (require.main === module) {
  const assert = require('node:assert');
  const s = signalsFromHtml('<p>Meet Maria Lopez, the owner.</p><footer>&copy; 2016 Joe\'s Plumbing. Website by Acme Web Studio</footer>', 2026);
  assert.deepStrictEqual(s, { ownerFirst: 'Maria', copyrightYear: 2016, builtBy: 'Acme Web Studio', hasTel: false, hasDescription: false });
  const t = signalsFromHtml('<meta name="description" content="Family plumbing in Arlington since 1990"><a href="tel:+17035551234">Call</a>');
  assert.strictEqual(t.hasTel, true);
  assert.strictEqual(t.hasDescription, true);
  assert.strictEqual(signalsFromHtml('<p>Our Team Owner</p> Powered by WordPress © 2025', 2026).builtBy, null);
  assert.strictEqual(signalsFromHtml('<p>Contact Us Owner</p>', 2026).ownerFirst, null);
  assert.strictEqual(signalsFromHtml('Dr. Sam Patel, DDS © 2019-2024', 2026).ownerFirst, 'Sam');
  assert.strictEqual(signalsFromHtml('© 2019-2024', 2026).copyrightYear, 2024);
  console.log('site-signals self-check OK');
}
