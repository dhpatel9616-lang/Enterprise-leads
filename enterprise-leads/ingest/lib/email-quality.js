// Shared "is this email address actually worth sending to?" checks.
//
// Used by: notion-leads-ingest.js (when it scrapes a mailto: link),
// enrich-emails.mjs (when it crawls contact pages), and
// outreach-sequencer.js (a final check right before anything is sent).
//
// Why this exists: website templates ship with placeholder addresses
// (user@domain.com, hi@mystore.com, test@email.com...) that look real to
// a scraper. Sending to them bounces, and every bounce hurts how Gmail
// rates the Wade Capital inbox, which pushes the NEXT real email toward
// spam. Two layers of defense:
//   1. A blocklist of known placeholder / junk patterns.
//   2. A free DNS lookup confirming the address's domain can receive
//      mail at all (has an "MX record"). Fake domains fail this.

const dns = require('node:dns').promises;

const JUNK_PATTERNS = [
  // image files and tracking services that look like emails
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /sentry\.io$/i,
  /sentry-next\.wixpress\.com$/i,
  /wixpress\.com$/i,
  /godaddy\.com$/i,
  /schema\.org$/i,
  /wordpress\.(com|org)$/i,
  // reserved / never-real domains
  /\.(test|invalid|example|local|localhost)$/i,
  /@example\.(com|org|net)$/i,
  // template placeholder domains
  /@(domain|yourdomain|yoursite|yourcompany|yourbusiness|yourwebsite|mysite|mystore|mydomain|mycompany|website|email|emailaddress|company|sample|business)\.(com|net|org|co)$/i,
  // template placeholder mailboxes on generic domains
  /^(test|user|you|your|yourname|name|email|john|jane|johndoe|janedoe|someone|example|firstname|first\.last)@/i,
  // mailboxes that never reach a human
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|abuse|bounce|bounces)@/i,
  // analytics / tracking / dev-tool vendors whose addresses leak into page scripts
  /@([a-z0-9-]+\.)?(keen\.io|segment\.(com|io)|mixpanel\.com|intercom\.io|hotjar\.com|cloudflare\.com|jquery\.com|github\.com|googlegroups\.com|squarespace\.com|wix\.com|shopify\.com|mailchimp\.com|sentry-cdn\.com)$/i,
  // our own address (the scraper's User-Agent contains it)
  /^wadecapitallc@gmail\.com$/i,
  // Credits scraped from a site's code, not the business (Oct 2026 bounces):
  // font designers' addresses in Google Fonts CSS, and form placeholders.
  /^(impallari|hello@indestructibletype|sorkintype|info@typetogether)/i,
  /^address@/i,
];

const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

// Cleans up what scrapers commonly drag in: "mailto:" prefixes,
// URL-encoding ("%20accurate1634@gmail.com"), stray punctuation.
function normalizeEmail(raw) {
  if (!raw) return null;
  let email = String(raw).trim();
  try {
    email = decodeURIComponent(email);
  } catch {
    // not URL-encoded — keep as-is
  }
  email = email
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim()
    .replace(/^[^a-z0-9]+/i, '')
    .replace(/[^a-z0-9]+$/i, '')
    .toLowerCase();
  return email || null;
}

function isJunkEmail(email) {
  return JUNK_PATTERNS.some((pattern) => pattern.test(email));
}

// Shape + blocklist only. Fast and offline — safe to call inside
// scraping loops.
function looksValid(raw) {
  const email = normalizeEmail(raw);
  if (!email || !EMAIL_SHAPE.test(email) || isJunkEmail(email)) return null;
  return email;
}

const mxCache = new Map();

async function domainAcceptsMail(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const records = await dns.resolveMx(domain);
    ok = Array.isArray(records) && records.some((r) => r.exchange && r.exchange !== '.');
  } catch (err) {
    // ENOTFOUND / ENODATA = domain doesn't exist or has no mail server.
    // Anything else (timeouts, SERVFAIL) is a DNS hiccup on our side —
    // don't punish the lead for that; let it through and let a real
    // bounce (if any) be caught by check-replies.js.
    ok = !['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN'].includes(err.code);
  }
  mxCache.set(domain, ok);
  return ok;
}

// The full pre-send check. Returns { ok, email, reason }.
// A generic inbox (info@, admin@...) at a domain other than the business's own
// site is usually a stale or unrelated address: 7 of 21 such sends bounced
// (33%, vs about 6% for everything else; Oct 2026 data).
const ROLE_INBOX = /^(info|admin|contact|office|hello|sales|support|manager|mail|team|service)@/;
function offsiteRoleInbox(email, siteUrl) {
  if (!siteUrl || !ROLE_INBOX.test(email)) return false;
  let host;
  try { host = new URL(siteUrl).hostname.replace(/^www\./, ''); } catch { return false; }
  const domain = email.split('@')[1];
  return !(domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
}

async function checkSendable(raw, siteUrl) {
  const email = normalizeEmail(raw);
  if (!email || !EMAIL_SHAPE.test(email)) return { ok: false, email, reason: 'bad_format' };
  if (isJunkEmail(email)) return { ok: false, email, reason: 'placeholder' };
  if (offsiteRoleInbox(email, siteUrl)) return { ok: false, email, reason: 'offsite_role_inbox' };
  const domain = email.split('@')[1];
  if (!(await domainAcceptsMail(domain))) return { ok: false, email, reason: 'no_mail_server' };
  return { ok: true, email, reason: null };
}

module.exports = { normalizeEmail, isJunkEmail, looksValid, checkSendable, domainAcceptsMail, offsiteRoleInbox };

if (require.main === module) {
  const assert = require('node:assert');
  assert.equal(offsiteRoleInbox('info@other.com', 'https://www.rivera.com/'), true);
  assert.equal(offsiteRoleInbox('info@rivera.com', 'https://www.rivera.com/'), false);
  assert.equal(offsiteRoleInbox('info@rivera.com', 'https://shop.rivera.com/'), false);
  assert.equal(offsiteRoleInbox('maria@gmail.com', 'https://rivera.com/'), false);
  assert.equal(offsiteRoleInbox('info@other.com', null), false);
  console.log('email-quality self-check passed');
}
