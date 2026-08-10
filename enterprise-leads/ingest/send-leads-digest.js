/**
 * Sends a weekday email summarizing leads captured today (or all
 * still-Unreviewed leads, per config) in the Notion Raw Leads Inbox.
 * Run AFTER notion-leads-ingest.js in the schedule.
 *
 * Requires RESEND_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID.
 * No-ops safely if any are missing, or if to_email is still the
 * placeholder in config/digest.json.
 */
const fs = require('fs');

const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';

const digestConfig = JSON.parse(fs.readFileSync('config/digest.json', 'utf-8'));

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

function renderDigestHTML(pages) {
  return `
  <div style="background:#11141b; padding:32px 24px; font-family:sans-serif;">
    <div style="max-width:520px; margin:0 auto;">
      <div style="font-weight:700; font-size:16px; color:#e9e7df; margin-bottom:4px;">RAW LEADS</div>
      <div style="font-family:monospace; font-size:11px; color:#8b93a7; margin-bottom:8px;">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${pages.map(renderRow).join('')}</table>
      <div style="font-family:sans-serif; font-size:12px; color:#8b93a7; margin-top:16px;">Review and approve in Notion's Raw Leads Inbox to promote into the Rolodex.</div>
    </div>
  </div>`;
}

async function run() {
  if (!RESEND_KEY || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
    console.log('send-leads-digest: one or more required secrets are missing. Skipping run.');
    return;
  }
  if (digestConfig.to_email.startsWith('YOUR_')) {
    console.log('send-leads-digest: config/digest.json still has the placeholder to_email — skipping send.');
    return;
  }

  const pages = await fetchLeads();
  if (pages.length === 0) {
    console.log('send-leads-digest: no leads to send today.');
    return;
  }

  const html = renderDigestHTML(pages);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: digestConfig.from_email,
      to: digestConfig.to_email,
      subject: `${digestConfig.subject_prefix} ${pages.length} new lead${pages.length === 1 ? '' : 's'} today`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);

  console.log(`send-leads-digest: sent ${pages.length} leads.`);
}

run().catch((err) => {
  console.error('send-leads-digest failed:', err);
  process.exit(1);
});
