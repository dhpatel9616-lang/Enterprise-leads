/**
 * Podcast guest outreach (owner, 2026-10-21): moves guests the owner wants on
 * The Sovereign podcast from Notion → "Podcast Guests" into the `leads`
 * table, so the outreach sequencer emails them like any other lead
 * (need_type `podcast_guest`, copy in settings.outreach.touch_sets.podcast_guest).
 *
 * Only rows with Status "Ready" AND a Contact email move. The weekly Podcast
 * Guest Research routine (enterprise-ops routines/podcast-guests.md) fills in
 * a public contact and the personal line, then sets Ready. A moved row
 * becomes "Queued" with its Lead ID. The personal line rides in
 * outreach_context ({context} in the email).
 *
 * Requires NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY; the database ID
 * comes from PODCAST_GUESTS_DB. No-ops safely if any are missing.
 * DRY_RUN=1 prints what would move.
 */
const { createClient } = require('@supabase/supabase-js');
const { looksValid } = require('./lib/email-quality');

const { NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, PODCAST_GUESTS_DB } = process.env;
const DRY_RUN = process.env.DRY_RUN === '1';
const NOTION_VERSION = '2022-06-28';
const text = (p) => (p?.rich_text || p?.title || []).map((t) => t.plain_text).join('').trim();

function rowToLead(page) {
  const p = page.properties;
  const email = looksValid(p['Contact email']?.email);
  const line = text(p['Personal line']);
  if (!email || !line) return null;
  return {
    business_name: text(p.Name),
    email,
    need_type: 'podcast_guest',
    category: 'podcast-guest',
    status: 'new',
    sequence_step: 0,
    notion_page_id: page.id,
    outreach_context: line.endsWith('.') || line.endsWith('!') || line.endsWith('?') ? line : `${line}.`,
    product_context: text(p['Topic idea']) || null,
  };
}

async function notion(path, body, method = 'POST') {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function run() {
  if (!NOTION_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PODCAST_GUESTS_DB) {
    return console.log('podcast-guests: a required secret or PODCAST_GUESTS_DB is missing. Skipping run.');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { results } = await notion(`databases/${PODCAST_GUESTS_DB}/query`, { filter: { property: 'Status', select: { equals: 'Ready' } }, page_size: 100 });
  let moved = 0;
  for (const page of results) {
    const lead = rowToLead(page);
    if (!lead) { console.log(`  - ${text(page.properties.Name)}: Ready but no valid email or personal line; skipped.`); continue; }
    const { data: dupe } = await supabase.from('leads').select('id').eq('email', lead.email).limit(1);
    if (DRY_RUN) { console.log(`  → [dry run] would queue ${lead.business_name} <${lead.email}>`); continue; }
    let id = dupe?.[0]?.id;
    if (!id) {
      const { data, error } = await supabase.from('leads').insert(lead).select('id').single();
      if (error) { console.error(`  ✗ ${lead.business_name}: ${error.message}`); continue; }
      id = data.id;
      moved++;
    }
    await notion(`pages/${page.id}`, { properties: { Status: { select: { name: 'Queued' } }, 'Lead ID': { rich_text: [{ text: { content: String(id) } }] } } }, 'PATCH');
  }
  console.log(`podcast-guests: ${results.length} Ready, ${moved} queued for outreach.`);
}

module.exports = { rowToLead };

if (require.main === module) {
  if (process.argv[2] === '--self-check') {
    const assert = require('node:assert');
    const t = (s) => ({ rich_text: [{ plain_text: s }] });
    const page = (email, line) => ({ id: 'p1', properties: { Name: { title: [{ plain_text: 'Ada Lovelace' }] }, 'Contact email': { email }, 'Personal line': t(line), 'Topic idea': t('') } });
    assert.equal(rowToLead(page('booking@ada.org', 'Your essay on engines stayed with me')).outreach_context, 'Your essay on engines stayed with me.');
    assert.equal(rowToLead(page('booking@ada.org', 'Loved it!')).outreach_context, 'Loved it!');
    assert.equal(rowToLead(page(null, 'x')), null);
    assert.equal(rowToLead(page('booking@ada.org', '')), null);
    assert.equal(rowToLead(page('booking@ada.org', 'x')).need_type, 'podcast_guest');
    console.log('podcast-guests self-check passed');
  } else {
    run().catch((err) => { console.error('podcast-guests failed:', err); process.exit(1); });
  }
}
