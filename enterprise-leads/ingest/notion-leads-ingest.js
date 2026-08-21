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
const NOTION_API = 'https://api.notion.com/v1';

const SOCIAL_DOMAINS = ['facebook.com/', 'instagram.com/', 'twitter.com/', 'x.com/', 'tiktok.com/', 'linkedin.com/company'];

async function searchPlaces(query, locationBias) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.id',
    },
    body: JSON.stringify({
      textQuery: query.q,
      locationBias: {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: locationBias.radius_meters,
        },
      },
      maxResultCount: 15,
    }),
  });
  const data = await res.json();
  return data.places || [];
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
  const hasSsl = url.startsWith('https://');
  let mobileOk = false;
  let email = null;
  let hasSocial = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    mobileOk = /<meta[^>]+name=["']viewport["']/i.test(html);
    const mailtoMatch = html.match(/mailto:([^"'?\s]+)/i);
    if (mailtoMatch) email = mailtoMatch[1];
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
        'Suggested Category': { multi_select: [{ name: 'Website Client' }] },
        'Source Detail': { rich_text: [{ text: { content: `Google Places — ${category} — ${locationName}` } }] },
        'Date Captured': { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion create page failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function mirrorToSupabase({ businessName, category, phone, email, siteUrl, hasSsl, mobileOk, hasSocial, needType, notionPageId }) {
  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('business_name', businessName)
    .eq('site_url', siteUrl)
    .maybeSingle();

  if (existing) return;

  await supabase.from('leads').insert({
    business_name: businessName,
    category,
    phone,
    email,
    site_url: siteUrl,
    has_ssl: hasSsl,
    mobile_ok: mobileOk,
    has_social: hasSocial,
    need_type: needType,
    status: 'new',
    sequence_step: 0,
    notion_page_id: notionPageId,
  });
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

// How many leads any single category is allowed to contribute in one run
// — keeps the daily batch a genuine mix of business types instead of
// letting one category (e.g. restaurants, if it happens to return the
// most hits) fill the whole day's quota on its own.
const CATEGORY_CAP_PER_RUN = 2;

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
  const queries = shuffle(buildQueries(config)); // rotate which location×category combos win the daily cap

  let processed = 0;
  let flagged = 0;
  let written = 0;
  const categoryCounts = {};

  for (const query of queries) {
    if (written >= maxNew) break;
    if ((categoryCounts[query.category] || 0) >= CATEGORY_CAP_PER_RUN) continue; // this category's already had its share today — try the next for variety

    const places = await searchPlaces(query, query.locationBias);
    const candidates = [];

    for (const place of places) {
      const businessName = place.displayName?.text || 'Unknown';
      const siteUrl = place.websiteUri || null;
      const phone = place.nationalPhoneNumber || null;
      const { hasSite, hasSsl, mobileOk, email, hasSocial } = await checkSite(siteUrl);
      const needType = classifyNeed({ hasSite, hasSsl, mobileOk, hasSocial });
      processed++;
      if (!needType) continue;
      flagged++;
      candidates.push({
        businessName, siteUrl, phone, hasSite, hasSsl, mobileOk, email, hasSocial, needType, placeId: place.id,
        score: priorityScore({ hasSite, hasSsl, mobileOk, hasSocial, needType }),
      });
    }

    candidates.sort((a, b) => b.score - a.score); // prime (worst web/social presence) candidates first

    for (const c of candidates) {
      if (written >= maxNew) break;
      if ((categoryCounts[query.category] || 0) >= CATEGORY_CAP_PER_RUN) break;

      const exists = await alreadyExists(c.businessName);
      if (exists) continue;

      const notionPageId = await createLeadPage({ ...c, category: query.category, locationName: query.locationName });
      await mirrorToSupabase({ ...c, category: query.category, notionPageId });
      written++;
      categoryCounts[query.category] = (categoryCounts[query.category] || 0) + 1;
    }
  }

  console.log(
    `notion-leads-ingest: processed ${processed}, flagged ${flagged}, wrote ${written} new leads across ${Object.keys(categoryCounts).length} categories (cap: ${maxNew}, max ${CATEGORY_CAP_PER_RUN}/category).`
  );
}

run().catch((err) => {
  console.error('notion-leads-ingest failed:', err);
  process.exit(1);
});
