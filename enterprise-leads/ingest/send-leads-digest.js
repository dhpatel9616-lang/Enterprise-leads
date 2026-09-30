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
    .neq('product', 'real_estate')
    .eq('do_not_call', false)
    .is('call_outcome', null)
    // Business landlines are called by the AI agent (bland-calls.js);
    // this list is for everything it can't legally call (cell phones,
    // unscreened numbers).
    .or('phone_type.is.null,phone_type.not.in.(landline,fixedVoip)')
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

// ---------- AI call results worth acting on ----------
async function fetchCallResults() {
  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const { data, error } = await supabase
    .from('leads')
    .select('business_name, phone, email, call_outcome, call_summary, callback_note, called_at')
    .in('call_outcome', ['interested', 'callback', 'send_info'])
    .gte('called_at', since)
    .order('called_at', { ascending: false });
  if (error) {
    console.error(`send-leads-digest: call results query failed: ${error.message}`);
    return [];
  }
  return data || [];
}

// ---------- Weekly real estate snapshot (Mondays) ----------
async function fetchRealEstate() {
  const { data: sellers } = await supabase
    .from('re_properties')
    .select('address, neighborhood, owner_1, owner_mailing, score, vacant_notice_date, assessed_value')
    .eq('status', 'new')
    .eq('absentee', true)
    .eq('owner_is_entity', false)
    .gte('score', 8)
    .order('vacant_notice_date', { ascending: true })
    .limit(10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: buyerLeads } = await supabase.from('leads').select('id', { count: 'exact', head: true }).eq('product', 'real_estate').gte('created_at', weekAgo);
  const { count: buyerEmails } = await supabase.from('leads').select('id', { count: 'exact', head: true }).eq('product', 'real_estate').gte('last_contacted', weekAgo);
  const { count: hot } = await supabase.from('re_properties').select('blocklot', { count: 'exact', head: true }).eq('status', 'new').eq('absentee', true).eq('owner_is_entity', false).gte('score', 8);
  return { sellers: sellers || [], buyerLeads: buyerLeads || 0, buyerEmails: buyerEmails || 0, hot: hot || 0 };
}

function renderCallResultRow(lead) {
  const tel = (lead.phone || '').replace(/[^0-9+]/g, '');
  const label = { interested: 'Interested', callback: 'Wants a callback', send_info: 'Asked for info' }[lead.call_outcome] || lead.call_outcome;
  return `
    <tr><td style="padding:9px 0; border-bottom:1px solid #2c3143;">
      <div style="font-size:15px; font-weight:600; color:#e9e7df;">${escapeHTML(lead.business_name)}
        <a href="tel:${tel}" style="color:#CDB07A; text-decoration:none; font-weight:500; margin-left:6px;">${escapeHTML(lead.phone || '')}</a></div>
      <div style="font-size:12px; color:#CDB07A; margin-top:3px;">${escapeHTML(label)}${lead.callback_note ? ` · ${escapeHTML(lead.callback_note)}` : ''}${lead.email ? ` · ${escapeHTML(lead.email)}` : ''}</div>
      <div style="font-size:12px; color:#c9c6bb; margin-top:3px;">${escapeHTML((lead.call_summary || '').slice(0, 400))}</div>
    </td></tr>`;
}

function renderRealEstate(re) {
  const rows = re.sellers
    .map(
      (p) => `
    <tr><td style="padding:8px 0; border-bottom:1px solid #2c3143;">
      <div style="font-size:14px; font-weight:600; color:#e9e7df;">${escapeHTML(p.address)} <span style="color:#8b93a7; font-weight:400;">${escapeHTML(p.neighborhood || '')}</span></div>
      <div style="font-size:12px; color:#c9c6bb; margin-top:2px;">Owner: ${escapeHTML(p.owner_1 || '')} · mail to ${escapeHTML(p.owner_mailing || '')}</div>
      <div style="font-family:monospace; font-size:11px; color:#8b93a7; margin-top:2px;">score ${p.score} · vacant since ${escapeHTML(p.vacant_notice_date || '?')} · assessed $${(p.assessed_value || 0).toLocaleString('en-US')}</div>
    </td></tr>`
    )
    .join('');
  return `<div style="font-size:13px; color:#c9c6bb; margin-bottom:8px;">${re.hot.toLocaleString('en-US')} Baltimore properties are vacant, absentee-owned by an individual, and score 8+. This week: ${re.buyerLeads} cash buyers added to outreach, ${re.buyerEmails} buyer emails sent. Top 10 to write to:</div><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
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

function renderDigestHTML({ pages, callList, replies, callResults = [], realEstate = null }) {
  const parts = [];
  if (callResults.length) parts.push(section(`FROM THE AI CALLS (${callResults.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${callResults.map(renderCallResultRow).join('')}</table><div style="font-size:12px; color:#8b93a7; margin-top:8px;">These people talked to the AI caller and want to hear from you. Call them back today.</div>`));
  if (replies.length) parts.push(section(`REPLIES WAITING (${replies.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${replies.map(renderReplyRow).join('')}</table><div style="font-size:12px; color:#8b93a7; margin-top:8px;">These are real people who wrote back. Answer them in the Wade Capital Gmail today.</div>`));
  if (callList.length) parts.push(section(`TODAY'S CALL LIST (${callList.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${callList.map(renderCallRow).join('')}</table><div style="font-size:12px; color:#8b93a7; margin-top:8px;">Opener: "Hi, this is Deven with Wade Capital. I help local businesses with their websites. Who handles that for you?" Tap a number to call.</div>`));
  if (pages.length) parts.push(section(`NEW LEADS CAPTURED (${pages.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${pages.map(renderRow).join('')}</table>`));
  if (realEstate) parts.push(section('REAL ESTATE: BALTIMORE (WEEKLY)', renderRealEstate(realEstate)));
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
  const callResults = await fetchCallResults();
  const isMonday = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }) === 'Monday';
  const realEstate = isMonday || process.env.FORCE_REAL_ESTATE === '1' ? await fetchRealEstate().catch(() => null) : null;
  if (pages.length === 0 && callList.length === 0 && replies.length === 0 && callResults.length === 0 && !realEstate) {
    console.log('send-leads-digest: nothing to send today.');
    return;
  }

  const html = renderDigestHTML({ pages, callList, replies, callResults, realEstate });
  const subjectBits = [];
  if (callResults.length) subjectBits.push(`${callResults.length} from AI calls`);
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
