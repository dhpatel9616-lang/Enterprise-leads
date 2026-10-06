/**
 * Sources local businesses via Google Places, flags ones with a
 * missing/weak website AND/OR no detectable social media presence,
 * classifies WHICH they need (website / social / both), and writes
 * them into Notion's "Raw Leads Inbox" + mirrors to Supabase.
 *
 * Locations and business categories are independent axes in settings
 * — every category is searched in every location, so adding one new
 * location instantly applies to all existing categories and vice
 * versa.
 *
 * Requires GOOGLE_PLACES_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID,
 * SUPABASE_URL, SUPABASE_SERVICE_KEY. No-ops safely if any are missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { looksValid } = require('./lib/email-quality');

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!PLACES_KEY || !NOTION_TOKEN || !NOTION_DATABASE_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.log('notion-leads-ingest: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const NOTION_VERSION = '2022-06-28';

// Some sites HTML-entity-encode their contact email to defeat simple
// regex scrapers (e.g. "info@x.com" becomes "&#105;&#110;&#102;...").
// Decode first, then run the shared quality check (lib/email-quality.js),
// which also rejects template placeholders like user@domain.com.
function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

const NOTION_API = 'https://api.notion.com/v1';

const SOCIAL_DOMAINS = ['facebook.com/', 'instagram.com/', 'twitter.com/', 'x.com/', 'tiktok.com/', 'linkedin.com/company'];

// Who we can actually help: an active, owner-run small business. Too few
// Google reviews usually means inactive or brand new (no budget yet); too
// many means a bigger operation with its own marketing team. Chain and
// franchise locations (store-locator URLs, or one website shared by several
// results) can't buy a website or social media on their own.
const CHAIN_URL = /\/(locations?|stores?|offices?|branches|find-a-|clinic-locator)(\/|-|$)/i;
function fitsSmallBusiness(place, sameSiteCount, cfg) {
  const reviews = place.userRatingCount || 0;
  if (reviews < (cfg.min_reviews ?? 5) || reviews > (cfg.max_reviews ?? 400)) return false;
  if (place.websiteUri && (CHAIN_URL.test(place.websiteUri) || sameSiteCount > 1)) return false;
  return true;
}

function siteHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Some categories aren't being evaluated for "does this business need a
// website/social fix" at all — the pitch is something else entirely, and
// every business in that category is worth reaching regardless of how
// good their existing site looks. 'legal' -> AI Governance Readiness
// Audit is the first case. Add more (category -> need_type) here as new
// non-website pitches launch, rather than writing new classifier logic.
const CATEGORY_NEED_OVERRIDES = {
  legal: 'governance_audit',
};

// Which `product` value a lead should be tagged with in Supabase, keyed
// by category. Anything not listed here defaults to 'enterprise'.
const CATEGORY_PRODUCT_MAP = {
  legal: 'legal_ai',
};

// Suggested Notion category tag, keyed by category. Anything not listed
// here defaults to 'Website Client'.
const CATEGORY_SUGGESTED_TAG = {
  legal: 'Legal AI Client',
};

async function searchPlaces(query, locationBias) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.id,places.businessStatus,places.userRatingCount',
    },
    body: JSON.stringify({
      textQuery: query.q,
      locationBias: {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: locationBias.radius_meters,
        },
      },
      pageSize: 20,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Places search failed: ${JSON.stringify(data).slice(0, 300)}`);
  // Skip businesses Google marks as closed.
  return (data.places || []).filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL');
}

// Checks the business's own site for: does it exist, is it mobile
// responsive, is it on SSL, is there a mailto: email, and does it
// LINK to any social platform. That last check is the only way we
// have to detect social presence — there's no direct API for it —
// so hasSocial is only meaningful (true/false) when hasSite is true.
// When there's no site at all, hasSocial comes back null ("unknown"),
// not false — we never claim a business lacks social media when we
// simply had no way to check.
async function checkSite(url) {
  if (!url) return { hasSite: false, hasSsl: false, mobileOk: false, email: null, hasSocial: null };
  // Listings often link http:// to sites that redirect to https, so try https
  // first and judge by where the page actually landed.
  let hasSsl = false;
  let mobileOk = false;
  let email = null;
  let hasSocial = false;
  try {
    const res = await fetch(url.replace(/^http:/i, 'https:'), { signal: AbortSignal.timeout(8000) })
      .catch(() => fetch(url, { signal: AbortSignal.timeout(8000) }));
    hasSsl = res.url.startsWith('https://');
    const html = await res.text();
    mobileOk = /<meta[^>]+name=["']viewport["']/i.test(html);
    const mailtoMatch = html.match(/mailto:([^"'?\s]+)/i);
    if (mailtoMatch) {
      email = looksValid(decodeHtmlEntities(mailtoMatch[1]));
    }
    hasSocial = SOCIAL_DOMAINS.some((domain) => html.toLowerCase().includes(domain));
  } catch {
    mobileOk = false;
  }
  return { hasSite: true, hasSsl, mobileOk, email, hasSocial };
}

// The core tailoring decision: what does this business actually need?
// 'website' — no site, or a broken one (drives the pitch even if
//   social status is unknown, since a broken site is the bigger issue).
// 'social' — the site itself is fine, but no social links found on it.
// 'both' — site has real problems AND no social links found.
function classifyNeed({ hasSite, hasSsl, mobileOk, hasSocial }) {
  const websiteBad = !hasSite || !hasSsl || !mobileOk;
  const socialBad = hasSite === true && hasSocial === false;
  if (websiteBad && socialBad) return 'both';
  if (websiteBad) return 'website';
  if (socialBad) return 'social';
  return null; // neither — not a lead
}

async function alreadyExists(businessName) {
  const res = await fetch(`${NOTION_API}/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'Company', rich_text: { equals: businessName } },
      page_size: 1,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion query failed: ${JSON.stringify(data)}`);
  return (data.results || []).length > 0;
}

async function createLeadPage({ businessName, phone, siteUrl, hasSite, hasSsl, mobileOk, email, hasSocial, needType, category, locationName, placeId }) {
  const socialLine =
    hasSocial === null ? 'Social media: unknown (no site to check)' : `Social media found on site: ${hasSocial ? 'yes' : 'NO'}`;
  const notesLines = [
    `Category: ${category}`,
    `Needs: ${needType}`,
    `Phone: ${phone || 'none listed'}`,
    `Email: ${email || 'not found — needs manual lookup'}`,
    hasSite ? `Site: ${siteUrl}` : 'Site: none found',
    hasSite ? `SSL: ${hasSsl ? 'yes' : 'NO'}` : '',
    hasSite ? `Mobile-friendly: ${mobileOk ? 'yes' : 'NO'}` : '',
    socialLine,
    `Google Place ID: ${placeId}`,
  ].filter(Boolean);

  const suggestedTag = CATEGORY_SUGGESTED_TAG[category] || 'Website Client';

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        'Lead Name': { title: [{ text: { content: businessName } }] },
        Company: { rich_text: [{ text: { content: businessName } }] },
        'Raw Notes': { rich_text: [{ text: { content: notesLines.join('\n') } }] },
        'Review Status': { select: { name: 'Unreviewed' } },
        'Suggested Category': { multi_select: [{ name: suggestedTag }] },
        'Source Detail': { rich_text: [{ text: { content: `Google Places — ${category} — ${locationName}` } }] },
        'Date Captured': { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion create page failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function mirrorToSupabase({ businessName, category, phone, email, siteUrl, hasSsl, mobileOk, hasSocial, needType, notionPageId, address, locationName, placeId }) {
  // `.eq('site_url', null)` never matches in SQL, so businesses with no
  // website used to slip past this duplicate check — use .is() for null.
  let dupeQuery = supabase.from('leads').select('id').eq('business_name', businessName);
  dupeQuery = siteUrl ? dupeQuery.eq('site_url', siteUrl) : dupeQuery.is('site_url', null);
  const { data: existing } = await dupeQuery.limit(1).maybeSingle();

  if (existing) return;

  const product = CATEGORY_PRODUCT_MAP[category] || 'enterprise';

  const { error } = await supabase.from('leads').insert({
    business_name: businessName,
    category,
    phone,
    email,
    site_url: siteUrl,
    has_ssl: hasSsl,
    mobile_ok: mobileOk,
    has_social: hasSocial,
    need_type: needType,
    product,
    status: 'new',
    sequence_step: 0,
    notion_page_id: notionPageId,
    address: address || null,
    location_name: locationName || null,
    google_place_id: placeId || null, // storing the place ID is allowed by Google's terms; the preview page uses it for live photos/hours
  });
  if (error) console.error(`notion-leads-ingest: Supabase insert failed for ${businessName}: ${error.message}`);
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Locations and categories are independent lists in settings — this
// builds every (location × category) combination as its own search.
// Add one new location and every existing category gets searched
// there automatically, and vice versa.
function buildQueries(config) {
  const combos = [];
  for (const location of config.locations) {
    for (const cat of config.categories) {
      combos.push({
        q: `${cat.search_term} in ${location.name}`,
        category: cat.category,
        locationName: location.name,
        locationBias: { lat: location.lat, lng: location.lng, radius_meters: location.radius_meters },
      });
    }
  }
  return combos;
}

// How many leads a single (category, location) combo is allowed to
// contribute in one run — keeps the daily batch a genuine mix of
// business types and locations instead of letting one combo (e.g.
// restaurants in State College, if it happens to return the most
// hits) fill the whole day's quota on its own. Keyed by
// category::location, NOT category alone — otherwise "law firms in
// State College" and "law firms in DC" would compete for the same
// shared budget the moment a second location is added.
const DEFAULT_COMBO_CAP = 5;

// ---- Google billing guard ----
// Asking Places for website + phone puts every search in Google's
// "Text Search Enterprise" price tier: the first 1,000 searches each
// month are free, then about $35 per 1,000. Every search is counted in
// the `places_usage` settings row, and the run stops before the monthly
// cap (default 950) so this never produces a bill.
function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

async function loadUsage() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'places_usage').maybeSingle();
  const value = data?.value || {};
  return value.month === monthKey() ? value : { month: monthKey(), searches: 0 };
}

async function saveUsage(usage) {
  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'places_usage', value: usage, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.error(`notion-leads-ingest: couldn't save search usage: ${error.message}`);
}

// Ranks candidates so the worst-off businesses (biggest real opportunity)
// get written first within a category, rather than whatever order Google
// Places happens to return. No website at all is the clearest gap; a
// site with real problems (no SSL, not mobile-friendly) is next; missing
// social alone is the mildest signal.
function priorityScore({ hasSite, hasSsl, mobileOk, hasSocial, needType }) {
  let score = 0;
  if (!hasSite) score += 4;
  else {
    if (!hasSsl) score += 2;
    if (!mobileOk) score += 2;
  }
  if (hasSocial === false) score += 2;
  if (needType === 'both') score += 1;
  return score;
}

async function run() {
  const config = await loadSetting(supabase, 'places_queries');
  const maxNew = config.max_new_leads_per_run ?? 10;
  const comboCap = config.max_per_combo_per_run ?? DEFAULT_COMBO_CAP;
  const maxSearchesThisRun = config.max_searches_per_run ?? 40;
  const monthlyCap = config.monthly_search_cap ?? 950;
  const usage = await loadUsage();
  let searchesThisRun = 0;
  const queries = shuffle(buildQueries(config)); // rotate which location×category combos win the daily cap

  let processed = 0;
  let flagged = 0;
  let written = 0;
  const categoryCounts = {};

  for (const query of queries) {
    if (written >= maxNew) break;
    const comboKey = `${query.category}::${query.locationName}`;
    if ((categoryCounts[comboKey] || 0) >= comboCap) continue; // this category/location combo already had its share today — try the next for variety
    if (searchesThisRun >= maxSearchesThisRun) break;
    if (usage.searches >= monthlyCap) {
      console.log(`notion-leads-ingest: ${usage.searches} Google searches used this month (cap ${monthlyCap}) — stopping to stay in the free tier.`);
      break;
    }

    let places;
    try {
      places = await searchPlaces(query, query.locationBias);
    } finally {
      // Saved after every search so a crash mid-run can't undercount.
      searchesThisRun++;
      usage.searches++;
      await saveUsage(usage);
    }
    const candidates = [];
    const siteCounts = {};
    for (const pl of places) { const h = siteHost(pl.websiteUri); if (h) siteCounts[h] = (siteCounts[h] || 0) + 1; }

    for (const place of places) {
      if (!fitsSmallBusiness(place, siteCounts[siteHost(place.websiteUri)] || 0, config)) continue;
      const businessName = place.displayName?.text || 'Unknown';
      const siteUrl = place.websiteUri || null;
      const phone = place.nationalPhoneNumber || null;
      const address = place.formattedAddress || null;
      const { hasSite, hasSsl, mobileOk, email, hasSocial } = await checkSite(siteUrl);
      // Website/social needs first (law firms included); the category pitch (e.g. legal AI) only when their web presence is already fine.
      const needType = classifyNeed({ hasSite, hasSsl, mobileOk, hasSocial }) || CATEGORY_NEED_OVERRIDES[query.category];
      processed++;
      if (!needType) continue;
      flagged++;
      candidates.push({
        businessName, siteUrl, phone, address, hasSite, hasSsl, mobileOk, email, hasSocial, needType, placeId: place.id,
        score: priorityScore({ hasSite, hasSsl, mobileOk, hasSocial, needType }) + (place.userRatingCount >= 20 && place.userRatingCount <= 150 ? 1 : 0),
      });
    }

    candidates.sort((a, b) => b.score - a.score); // prime (worst web/social presence) candidates first

    for (const c of candidates) {
      if (written >= maxNew) break;
      if ((categoryCounts[comboKey] || 0) >= comboCap) break;

      const exists = await alreadyExists(c.businessName);
      if (exists) continue;

      const notionPageId = await createLeadPage({ ...c, category: query.category, locationName: query.locationName });
      await mirrorToSupabase({ ...c, category: query.category, notionPageId, locationName: query.locationName });
      written++;
      categoryCounts[comboKey] = (categoryCounts[comboKey] || 0) + 1;
    }
  }

  console.log(
    `notion-leads-ingest: ${searchesThisRun} Google searches (${usage.searches}/${monthlyCap} this month), processed ${processed}, flagged ${flagged}, wrote ${written} new leads across ${Object.keys(categoryCounts).length} category/location combos (cap: ${maxNew}, max ${comboCap}/combo).`
  );
}

run().catch((err) => {
  console.error('notion-leads-ingest failed:', err);
  process.exit(1);
});
