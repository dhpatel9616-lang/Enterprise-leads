// Free, no-AI details read from a business's own homepage, used to make the
// first email specific: the owner's first name (for "Hi Maria,"), an old
// copyright year (a concrete, checkable sign the site is neglected), and a
// "website by <agency>" credit (they already pay someone; lower priority).
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
  const text = visibleText(html || '');
  return { ownerFirst: ownerFirstName(text), copyrightYear: copyrightYear(text, nowYear), builtBy: builtBy(text) };
}

async function fetchSignals(url, timeoutMs = 8000) {
  if (!url) return { ownerFirst: null, copyrightYear: null, builtBy: null };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WadeCapitalBot/1.0)' } });
    return signalsFromHtml(await res.text());
  } catch {
    return { ownerFirst: null, copyrightYear: null, builtBy: null };
  }
}

module.exports = { signalsFromHtml, fetchSignals };

// Self-check: node ingest/lib/site-signals.js
if (require.main === module) {
  const assert = require('node:assert');
  const s = signalsFromHtml('<p>Meet Maria Lopez, the owner.</p><footer>&copy; 2016 Joe\'s Plumbing. Website by Acme Web Studio</footer>', 2026);
  assert.deepStrictEqual(s, { ownerFirst: 'Maria', copyrightYear: 2016, builtBy: 'Acme Web Studio' });
  assert.strictEqual(signalsFromHtml('<p>Our Team Owner</p> Powered by WordPress © 2025', 2026).builtBy, null);
  assert.strictEqual(signalsFromHtml('<p>Contact Us Owner</p>', 2026).ownerFirst, null);
  assert.strictEqual(signalsFromHtml('Dr. Sam Patel, DDS © 2019-2024', 2026).ownerFirst, 'Sam');
  assert.strictEqual(signalsFromHtml('© 2019-2024', 2026).copyrightYear, 2024);
  console.log('site-signals self-check OK');
}
