/**
 * Reads leads from the Supabase `leads` table, figures out which
 * ones are due for their next outreach touch (day 0 / day 4 / day 10,
 * per config/outreach.json), generates a "before" screenshot of their
 * current site, sends the email via Resend, and advances their
 * sequence_step + last_contacted.
 *
 * Leads with no email on file are skipped and logged — Google Places
 * doesn't provide emails, and only some get picked up by the mailto:
 * scan in the ingest script. The rest need a manual lookup; this
 * script never guesses an address.
 *
 * To stop the sequence early for a lead (they replied, became a
 * client, or you want to drop them), just change its `status` in
 * Supabase to 'replied', 'client', or 'cold' — this script only
 * touches rows still at 'new' or 'contacted'.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY.
 * No-ops safely if any are missing.
 */
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_KEY) {
  console.log('outreach-sequencer: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync('config/outreach.json', 'utf-8'));
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function screenshotUrl(siteUrl) {
  // thum.io's free tier — no API key/signup needed. Rate-limited, but
  // comfortably covers 15-25 sends/day. Swap for a paid screenshot API
  // later if you outgrow it.
  return `https://image.thum.io/get/width/900/crop/650/${siteUrl}`;
}

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

function issueLine(lead) {
  if (!lead.site_url) return "doesn't currently have a website";
  if (!lead.mobile_ok) return "doesn't render well on mobile";
  if (!lead.has_ssl) return "isn't running on a secure connection (no SSL)";
  return 'could use a refresh';
}

async function fetchDueLeads() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['new', 'contacted'])
    .not('email', 'is', null)
    .lt('sequence_step', config.touches.length);
  if (error) throw error;
  return leads || [];
}

function isDue(lead) {
  const nextStep = lead.sequence_step + 1;
  const touch = config.touches.find((t) => t.step === nextStep);
  if (!touch) return false;
  if (lead.sequence_step === 0) return true; // first touch, always due immediately
  const daysSince = (Date.now() - new Date(lead.last_contacted).getTime()) / 86400000;
  return daysSince >= touch.delay_days;
}

async function updateNotionOutreachStatus(lead, nextStep) {
  if (!NOTION_TOKEN || !lead.notion_page_id) return; // no-ops if either is missing, never blocks the send
  const res = await fetch(`https://api.notion.com/v1/pages/${lead.notion_page_id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        'Outreach Step': { number: nextStep },
        'Last Outreach': { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    }),
  });
  if (!res.ok) console.error(`Notion sync-back failed for ${lead.business_name}: ${await res.text()}`);
}

async function sendTouch(lead) {
  const nextStep = lead.sequence_step + 1;
  const touch = config.touches.find((t) => t.step === nextStep);

  const vars = { business_name: lead.business_name, sender_name: config.sender_name, issue_line: issueLine(lead) };
  const subject = fillTemplate(touch.subject, vars);
  const bodyText = fillTemplate(touch.body, vars);

  const screenshotHtml = lead.site_url
    ? `<div style="margin:20px 0;"><img src="${screenshotUrl(lead.site_url)}" alt="${lead.business_name}'s current site" style="max-width:100%; border:1px solid #333;" /></div>`
    : '';

  const html = `
    <div style="font-family:sans-serif; font-size:15px; line-height:1.5; color:#1a1a1a;">
      ${bodyText.split('\n').map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('')}
      ${screenshotHtml}
    </div>`;

  // Test mode redirects every send to your own inbox instead of the
  // real business — lets you verify copy/formatting/screenshots
  // without ever emailing a real lead.
  const isTest = config.test_mode === true;
  const toAddress = isTest ? config.test_recipient_email : lead.email;
  const finalSubject = isTest ? `[TEST for ${lead.business_name}, step ${nextStep}] ${subject}` : subject;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: config.from_email,
      to: toAddress,
      reply_to: config.reply_to_email,
      subject: finalSubject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);

  // In test mode, don't advance real sequence state — the point is to
  // preview the same lead's next touch again next run, not burn through
  // the real cadence while testing.
  if (isTest) return;

  const isLastTouch = nextStep === config.touches.length;
  await supabase
    .from('leads')
    .update({
      sequence_step: nextStep,
      last_contacted: new Date().toISOString(),
      status: isLastTouch ? 'cold' : 'contacted',
    })
    .eq('id', lead.id);

  await updateNotionOutreachStatus(lead, nextStep);
}

async function run() {
  if (config.reply_to_email.startsWith('YOUR_') || config.sender_name.startsWith('YOUR_')) {
    console.log('outreach-sequencer: config/outreach.json still has placeholder values — skipping run.');
    return;
  }

  const leads = await fetchDueLeads();
  const due = leads.filter(isDue).slice(0, config.max_sends_per_run);

  let sent = 0;
  for (const lead of due) {
    await sendTouch(lead);
    sent++;
  }

  console.log(
    `outreach-sequencer: ${leads.length} leads eligible, ${due.length} due this run, sent ${sent}.${config.test_mode ? ' [TEST MODE — sent to test_recipient_email, no lead touched, no state advanced]' : ''}`
  );
}

run().catch((err) => {
  console.error('outreach-sequencer failed:', err);
  process.exit(1);
});
