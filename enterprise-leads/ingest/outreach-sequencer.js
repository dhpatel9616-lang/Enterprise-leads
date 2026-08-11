/**
 * Reads leads from the Supabase `leads` table, figures out which ones
 * are due for their next outreach touch, and sends a TAILORED email
 * based on what that lead actually needs (need_type: 'website',
 * 'social', or 'both' — set during ingest). Sends via YOUR Gmail
 * account, advances sequence_step, syncs status to Notion.
 *
 * Touch 1 differs by need_type (settings.outreach.touch_sets).
 * Touches 2+ are shared copy (settings.outreach.followups) with an
 * {offer_phrase} placeholder that still reflects the right offer —
 * keeps the config from needing 18 separate hand-written emails.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if any are
 * missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { sendGmail } = require('./lib/gmail');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
  console.log('outreach-sequencer: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
let config;

function screenshotUrl(siteUrl) {
  return `https://image.thum.io/get/width/900/crop/650/${siteUrl}`;
}

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

const OFFER_PHRASES = {
  website: 'your website',
  social: 'your social media presence',
  both: 'your website and social media',
};

function issueLine(lead) {
  if (lead.need_type === 'social') return "doesn't have an active social media presence I could find";
  if (lead.need_type === 'both') return "doesn't currently have a working website or an active social media presence I could find";
  if (!lead.site_url) return "doesn't currently have a website";
  if (!lead.mobile_ok) return "doesn't render well on mobile";
  if (!lead.has_ssl) return "isn't running on a secure connection (no SSL)";
  return 'could use a refresh';
}

function totalSteps() {
  return 1 + config.followups.length; // touch 1 (need-specific) + shared followups
}

function touchForStep(lead, step) {
  if (step === 1) {
    const set = config.touch_sets[lead.need_type] || config.touch_sets.website;
    return set[0];
  }
  return config.followups[step - 2]; // followups[0] is step 2, etc.
}

async function fetchDueLeads() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['new', 'contacted'])
    .not('email', 'is', null)
    .not('need_type', 'is', null)
    .lt('sequence_step', totalSteps());
  if (error) throw error;
  return leads || [];
}

function isDue(lead) {
  const nextStep = lead.sequence_step + 1;
  const touch = touchForStep(lead, nextStep);
  if (!touch) return false;
  if (lead.sequence_step === 0) return true;
  const daysSince = (Date.now() - new Date(lead.last_contacted).getTime()) / 86400000;
  return daysSince >= touch.delay_days;
}

async function updateNotionOutreachStatus(lead, nextStep) {
  if (!NOTION_TOKEN || !lead.notion_page_id) return;
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
  const touch = touchForStep(lead, nextStep);
  const offerPhrase = OFFER_PHRASES[lead.need_type] || OFFER_PHRASES.website;

  const vars = {
    business_name: lead.business_name,
    sender_name: config.sender_name,
    issue_line: issueLine(lead),
    offer_phrase: offerPhrase,
  };
  const subject = fillTemplate(touch.subject, vars);
  const bodyText = fillTemplate(touch.body, vars);
  const threadedSubject = nextStep > 1 ? `Re: ${subject}` : subject;

  // Only show the "before" screenshot when the pitch is actually
  // about the website — showing a broken-site screenshot to a lead
  // whose site is fine (pure social pitch) would undercut the email.
  const showScreenshot = lead.site_url && (lead.need_type === 'website' || lead.need_type === 'both');
  const screenshotHtml = showScreenshot
    ? `<div style="margin:20px 0;"><img src="${screenshotUrl(lead.site_url)}" alt="${lead.business_name}'s current site" style="max-width:100%; border:1px solid #333;" /></div>`
    : '';

  const html = `
    <div style="font-family:sans-serif; font-size:15px; line-height:1.5; color:#1a1a1a;">
      ${bodyText.split('\n').map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('')}
      ${screenshotHtml}
    </div>`;

  const isTest = config.test_mode === true;
  const toAddress = isTest ? config.test_recipient_email : lead.email;
  const finalSubject = isTest ? `[TEST for ${lead.business_name}, ${lead.need_type}, step ${nextStep}] ${threadedSubject}` : threadedSubject;
  const replyTo = config.reply_to_email && !config.reply_to_email.startsWith('YOUR_') ? config.reply_to_email : undefined;
  const threadId = !isTest && nextStep > 1 ? lead.gmail_thread_id : undefined;

  const result = await sendGmail({ to: toAddress, subject: finalSubject, html, replyTo, threadId });

  if (isTest) return;

  const isLastTouch = nextStep === totalSteps();
  const updates = {
    sequence_step: nextStep,
    last_contacted: new Date().toISOString(),
    status: isLastTouch ? 'cold' : 'contacted',
  };
  if (nextStep === 1) updates.gmail_thread_id = result.threadId;

  await supabase.from('leads').update(updates).eq('id', lead.id);
  await updateNotionOutreachStatus(lead, nextStep);
}

async function run() {
  config = await loadSetting(supabase, 'outreach');

  if (config.sender_name.startsWith('YOUR_')) {
    console.log('outreach-sequencer: settings.outreach still has a placeholder sender_name — skipping run.');
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
    `outreach-sequencer: ${leads.length} leads eligible, ${due.length} due this run, sent ${sent}.${config.test_mode ? ' [TEST MODE]' : ''}`
  );
}

run().catch((err) => {
  console.error('outreach-sequencer failed:', err);
  process.exit(1);
});
