/**
 * Sources local businesses via Google Places, flags ones with a
 * missing/weak website, and writes them directly into the Notion
 * "Raw Leads Inbox" database (Review Status starts "Unreviewed",
 * same promote-to-Rolodex flow already built in Notion).
 *
 * Requires GOOGLE_PLACES_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID.
 * No-ops safely (logs and exits 0) if any are missing — never
 * breaks a run just because one piece isn't configured yet.
 */
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!PLACES_KEY || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
  console.log('notion-leads-ingest: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

// Supabase is optional here — Notion is the source of truth for review/
// triage. If Supabase creds aren't set, we just skip the mirror write
// rather than failing the whole run.
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

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

async function checkSite(url) {
  if (!url) return { hasSite: false, hasSsl: false, mobileOk: false, email: null };
  const hasSsl = url.startsWith('https://');
  let mobileOk = false;
  let email = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    mobileOk = /<meta[^>]+name=["']viewport["']/i.test(html);
    // Cheap, free email enrichment: look for a mailto: link on the
    // homepage. Catches maybe half of small business sites. The rest
    // need a manual lookup — the outreach sequencer skips and logs
    // any lead with no email rather than guessing one.
    const mailtoMatch = html.match(/mailto:([^"'?\s]+)/i);
    if (mailtoMatch) email = mailtoMatch[1];
  } catch {
    mobileOk = false;
  }
  return { hasSite: true, hasSsl, mobileOk, email };
}

// Dedup: check if a page with this exact Company name already exists
// before creating a new one, so re-running never duplicates a lead.
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

async function createLeadPage({ businessName, phone, siteUrl, hasSite, hasSsl, mobileOk, email, category, placeId }) {
  const notesLines = [
    `Category: ${category}`,
    `Phone: ${phone || 'none listed'}`,
    `Email: ${email || 'not found — needs manual lookup'}`,
    hasSite ? `Site: ${siteUrl}` : 'Site: none found',
    hasSite ? `SSL: ${hasSsl ? 'yes' : 'NO'}` : '',
    hasSite ? `Mobile-friendly: ${mobileOk ? 'yes' : 'NO'}` : '',
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
        'Source Detail': { rich_text: [{ text: { content: `Google Places — ${category} — State College, PA` } }] },
        'Date Captured': { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion create page failed: ${JSON.stringify(data)}`);
}

// Mirrors the lead into Supabase's `leads` table — this is what the
// outreach sequencer reads/writes (status, last_contacted, sequence_step).
// Notion's Review Status is a separate, human-facing concept; this row
// is the machine-tracked outreach state. Skips silently if a row for
// this business_name + site_url already exists.
async function mirrorToSupabase({ businessName, category, phone, email, siteUrl, hasSsl, mobileOk }) {
  if (!supabase) return;

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
    status: 'new',
    sequence_step: 0,
  });
}

async function run() {
  const config = JSON.parse(fs.readFileSync('config/places-queries.json', 'utf-8'));

  let processed = 0;
  let flagged = 0;
  let written = 0;

  for (const query of config.queries) {
    const places = await searchPlaces(query, config.location_bias);

    for (const place of places) {
      const businessName = place.displayName?.text || 'Unknown';
      const siteUrl = place.websiteUri || null;
      const phone = place.nationalPhoneNumber || null;

      const { hasSite, hasSsl, mobileOk, email } = await checkSite(siteUrl);
      const failCount = [!hasSite, hasSite && !hasSsl, hasSite && !mobileOk].filter(Boolean).length;
      const isHot = !hasSite || failCount >= 2;

      if (isHot) {
        flagged++;
        const exists = await alreadyExists(businessName);
        if (!exists) {
          await createLeadPage({
            businessName,
            phone,
            siteUrl,
            hasSite,
            hasSsl,
            mobileOk,
            email,
            category: query.category,
            placeId: place.id,
          });
          await mirrorToSupabase({ businessName, category: query.category, phone, email, siteUrl, hasSsl, mobileOk });
          written++;
        }
      }
      processed++;
    }
  }

  console.log(`notion-leads-ingest: processed ${processed}, flagged ${flagged}, wrote ${written} new leads to Notion.`);
}

run().catch((err) => {
  console.error('notion-leads-ingest failed:', err);
  process.exit(1);
});
