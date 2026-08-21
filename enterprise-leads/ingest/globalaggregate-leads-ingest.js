/**
 * Sources GlobalAggregate promotion leads from two curated seed lists
 * (settings.globalaggregate.seed_outlets and .research_targets) —
 * NOT a live API search like Enterprise Leads' Google Places ingest.
 * See the brief: reciprocal-link outlets are a known list from
 * GlobalAggregate's own RSS config, and research contacts are a small,
 * finite universe of journalism-research programs. Both get curated by
 * hand in Supabase settings, not discovered automatically (yet).
 *
 * Writes new leads into the SAME "Raw Leads Inbox" Notion database and
 * the SAME Supabase `leads` table Enterprise Leads uses, tagged
 * product: 'globalaggregate' and need_type: 'reciprocal_link' or
 * 'research_contact'. The existing outreach-sequencer.js, check-replies.js,
 * and send-leads-digest.js all pick these up automatically — no changes
 * needed there beyond the OFFER_PHRASES addition in outreach-sequencer.js.
 *
 * Requires NOTION_TOKEN, NOTION_DATABASE_ID, SUPABASE_URL,
 * SUPABASE_SERVICE_KEY. No-ops safely if any are missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!NOTION_TOKEN || !NOTION_DATABASE_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.log('globalaggregate-leads-ingest: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

const NEED_TYPE_META = {
  reciprocal_link: {
    category: 'GA Reciprocal Link',
    sourceLabel: 'GlobalAggregate seed list — reciprocal link',
  },
  research_contact: {
    category: 'GA Research Contact',
    sourceLabel: 'GlobalAggregate seed list — research contact',
  },
};

async function alreadyExistsInNotion(name) {
  const res = await fetch(`${NOTION_API}/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'Company', rich_text: { equals: name } },
      page_size: 1,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion query failed: ${JSON.stringify(data)}`);
  return (data.results || []).length > 0;
}

async function createLeadPage({ name, siteUrl, email, context, needType }) {
  const meta = NEED_TYPE_META[needType];
  const notesLines = [
    `Type: ${needType}`,
    `Site: ${siteUrl || 'none listed'}`,
    `Email: ${email || 'not found — needs manual lookup'}`,
    context ? `Context: ${context}` : '',
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
        'Lead Name': { title: [{ text: { content: name } }] },
        Company: { rich_text: [{ text: { content: name } }] },
        'Raw Notes': { rich_text: [{ text: { content: notesLines.join('\n') } }] },
        'Review Status': { select: { name: 'Unreviewed' } },
        'Suggested Category': { multi_select: [{ name: meta.category }] },
        Product: { select: { name: 'GlobalAggregate' } },
        'Source Detail': { rich_text: [{ text: { content: meta.sourceLabel } }] },
        'Date Captured': { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion create page failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function mirrorToSupabase({ name, siteUrl, email, context, needType, notionPageId }) {
  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('business_name', name)
    .eq('product', 'globalaggregate')
    .maybeSingle();

  if (existing) return;

  await supabase.from('leads').insert({
    business_name: name,
    category: needType,
    email: email || null,
    site_url: siteUrl || null,
    product: 'globalaggregate',
    need_type: needType,
    outreach_context: context || null,
    status: 'new',
    sequence_step: 0,
    notion_page_id: notionPageId,
  });
}

async function ingestList(list, needType, maxRemaining) {
  let written = 0;
  for (const entry of list) {
    if (written >= maxRemaining) break;
    if (!entry.name) continue;

    const exists = await alreadyExistsInNotion(entry.name);
    if (exists) continue;

    const notionPageId = await createLeadPage({
      name: entry.name,
      siteUrl: entry.site_url,
      email: entry.email,
      context: entry.context,
      needType,
    });
    await mirrorToSupabase({
      name: entry.name,
      siteUrl: entry.site_url,
      email: entry.email,
      context: entry.context,
      needType,
      notionPageId,
    });
    written++;
  }
  return written;
}

async function run() {
  const config = await loadSetting(supabase, 'globalaggregate');
  const maxNew = config.max_new_leads_per_run ?? 10;

  const writtenOutlets = await ingestList(config.seed_outlets || [], 'reciprocal_link', maxNew);
  const remaining = maxNew - writtenOutlets;
  const writtenResearch = remaining > 0 ? await ingestList(config.research_targets || [], 'research_contact', remaining) : 0;

  console.log(
    `globalaggregate-leads-ingest: wrote ${writtenOutlets} reciprocal-link leads, ${writtenResearch} research-contact leads (cap: ${maxNew}).`
  );
}

run().catch((err) => {
  console.error('globalaggregate-leads-ingest failed:', err);
  process.exit(1);
});
