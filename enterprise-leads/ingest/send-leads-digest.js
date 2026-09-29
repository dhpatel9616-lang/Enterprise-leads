/**
 * Sends a weekday email summarizing leads captured today (or all
 * still-Unreviewed leads, per config) in the Notion Raw Leads Inbox.
 * Run AFTER notion-leads-ingest.js in the schedule.
 *
 * Requires RESEND_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID.
 * No-ops safely if any are missing, or if to_email is still the
 * placeholder in config/digest.json.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { previewUrl } = require('./lib/preview');
let previewBase = null; // from settings.outreach.preview_base_url

const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_VERSION = '2022-06-28';

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;
let digestConfig; // loaded from Supabase settings table at the start of run()

async function fetchLeads() {
  const filter = digestConfig.only_todays_captures
    ? {
        and: [
          { property: 'Review Status', select: { equals: 'Unreviewed' } },
          { property: 'Date Captured', date: { equals: new Date().toISOString().slice(0, 10) } },
        ],
      }
    : { property: 'Review Status', select: { equals: 'Unreviewed' } };

  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filter, page_size: 100 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion query failed: ${JSON.stringify(data)}`);
  return data.results || [];
}

function escapeHTML(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRow(page) {
  const name = page.properties['Lead Name']?.title?.[0]?.plain_text || 'Unnamed lead';
  const notes = page.properties['Raw Notes']?.rich_text?.[0]?.plain_text || '';
  const source = page.properties['Source Detail']?.rich_text?.[0]?.plain_text || '';
  return `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid #2c3143;">
        <div style="font-family:sans-serif; font-size:15px; font-weight:600; color:#e9e7df;">${escapeHTML(name)}</div>
        <div style="font-family:monospace; font-size:11px; color:#8b93a7; margin-top:3px; white-space:pre-line;">${escapeHTML(source)}\n${escapeHTML(notes)}</div>
      </td>
    </tr>`;
}

// ---------- Call list ----------
// Businesses we can't reach by email (no address found, or it bounced)
// but DO have a phone number. No website at all first — they're the
// strongest website-studio prospects — then the rest, oldest first.
async function fetchCallList(limit) {
  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, category, phone, site_url, address, location_name, status, need_type, created_at')
    .not('phone', 'is', null)
    .or('status.eq.bounced,status.eq.bad_email,and(status.eq.new,email.is.null)')
    .neq('need_type', 'governance_audit')
    // Rotates: anyone shown in the last 14 days sits out, so each
    // day's list is new names.
    .or(`call_listed_at.is.null,call_listed_at.lt.${new Date(Date.now() - 14 * 86400000).toISOString()}`)
    .order('created_at', { ascending: true })
    .limit(300);
  if (error) {
    console.error(`send-leads-digest: call list query failed: ${error.message}`);
    return [];
  }
  const rows = data || [];
  rows.sort((a, b) => (a.site_url ? 1 : 0) - (b.site_url ? 1 : 0));
  return rows.slice(0, limit);
}

// ---------- Real replies from the last few days ----------
async function fetchRecentReplies() {
  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const { data, error } = await supabase
    .from('leads')
    .select('business_name, email, phone, category, replied_at')
    .eq('reply_kind', 'reply')
    .gte('replied_at', since)
    .order('replied_at', { ascending: false });
  if (error) {
    console.error(`send-leads-digest: replies query failed: ${error.message}`);
    return [];
  }
  return data || [];
}

function pitchFor(lead) {
  if (!lead.site_url) return 'No website. Offer: free mockup, then a fixed-price site.';
  if (lead.status === 'bounced') return 'Email bounced. Ask for the best email and pitch the site refresh.';
  return 'Site has issues. Offer: website refresh + automated social posting.';
}

function section(title, inner) {
  return `<div style="font-weight:700; font-size:14px; color:#CDB07A; margin:28px 0 6px; letter-spacing:.04em;">${title}</div>${inner}`;
}

function mockLink(lead) {
  const url = previewUrl(lead, previewBase);
  if (!url) return '';
  return `<div style="font-size:12px; margin-top:4px;"><a href="${escapeHTML(url)}" style="color:#CDB07A;">Their free mockup site</a> <span style="color:#8b93a7;">(offer to text or email it during the call)</span></div>`;
}

function renderCallRow(lead) {
  const tel = (lead.phone || '').replace(/[^0-9+]/g, '');
  const where = [lead.category, lead.location_name || lead.address].filter(Boolean).join(' · ');
  return `
    <tr><td style="padding:9px 0; border-bottom:1px solid #2c3143;">
      <div style="font-size:15px; font-weight:600; color:#e9e7df;">${escapeHTML(lead.business_name)}
        <a href="tel:${tel}" style="color:#CDB07A; text-decoration:none; font-weight:500; margin-left:6px;">${escapeHTML(lead.phone)}</a></div>
      <div style="font-family:monospace; font-size:11px; color:#8b93a7; margin-top:3px;">${escapeHTML(where)}</div>
      <div style="font-size:12px; color:#c9c6bb; margin-top:3px;">${escapeHTML(pitchFor(lead))}</div>
      ${mockLink(lead)}
    </td></tr>`;
}

function renderReplyRow(lead) {
  return `
    <tr><td style="padding:9px 0; border-bottom:1px solid #2c3143;">
      <div style="font-size:15px; font-weight:600; color:#e9e7df;">${escapeHTML(lead.business_name)}</div>
      <div style="font-family:monospace; font-size:11px; color:#8b93a7; margin-top:3px;">${escapeHTML(lead.email || '')} ${escapeHTML(lead.phone || '')}</div>
    </td></tr>`;
}

function renderDigestHTML({ pages, callList, replies }) {
  const parts = [];
  if (replies.length) parts.push(section(`REPLIES WAITING (${replies.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${replies.map(renderReplyRow).join('')}</table><div style="font-size:12px; color:#8b93a7; margin-top:8px;">These are real people who wrote back. Answer them in the Wade Capital Gmail today.</div>`));
  if (callList.length) parts.push(section(`TODAY'S CALL LIST (${callList.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${callList.map(renderCallRow).join('')}</table><div style="font-size:12px; color:#8b93a7; margin-top:8px;">Opener: "Hi, this is Deven with Wade Capital. I help local businesses with their websites. Who handles that for you?" Tap a number to call.</div>`));
  if (pages.length) parts.push(section(`NEW LEADS CAPTURED (${pages.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${pages.map(renderRow).join('')}</table>`));
  return `
  <div style="background:#11141b; padding:32px 24px; font-family:sans-serif;">
    <div style="max-width:560px; margin:0 auto;">
      <div style="font-weight:700; font-size:16px; color:#e9e7df; margin-bottom:4px;">ENTERPRISE LEADS</div>
      <div style="font-family:monospace; font-size:11px; color:#8b93a7;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}</div>
      ${parts.join('')}
    </div>
  </div>`;
}

async function run() {
  if (!RESEND_KEY || !NOTION_TOKEN || !NOTION_DATABASE_ID || !supabase) {
    console.log('send-leads-digest: one or more required secrets are missing. Skipping run.');
    return;
  }
  digestConfig = await loadSetting(supabase, 'digest');
  try {
    previewBase = (await loadSetting(supabase, 'outreach')).preview_base_url || null;
  } catch {
    previewBase = null;
  }
  if (digestConfig.to_email.startsWith('YOUR_')) {
    console.log('send-leads-digest: settings.digest still has the placeholder to_email — skipping send.');
    return;
  }

  const pages = await fetchLeads();
  const callList = await fetchCallList(digestConfig.call_list_size ?? 15);
  const replies = await fetchRecentReplies();
  if (pages.length === 0 && callList.length === 0 && replies.length === 0) {
    console.log('send-leads-digest: nothing to send today.');
    return;
  }

  const html = renderDigestHTML({ pages, callList, replies });
  const subjectBits = [];
  if (replies.length) subjectBits.push(`${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`);
  subjectBits.push(`${callList.length} to call`);
  subjectBits.push(`${pages.length} new lead${pages.length === 1 ? '' : 's'}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: digestConfig.from_email,
      to: digestConfig.to_email,
      subject: `${digestConfig.subject_prefix} ${subjectBits.join(', ')}`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);

  if (callList.length) {
    const { error: markErr } = await supabase
      .from('leads')
      .update({ call_listed_at: new Date().toISOString() })
      .in('id', callList.map((l) => l.id));
    if (markErr) console.error(`send-leads-digest: couldn't mark call list rotation: ${markErr.message}`);
  }

  console.log(`send-leads-digest: sent (${replies.length} replies, ${callList.length} calls, ${pages.length} new leads).`);
}

run().catch((err) => {
  console.error('send-leads-digest failed:', err);
  process.exit(1);
});
