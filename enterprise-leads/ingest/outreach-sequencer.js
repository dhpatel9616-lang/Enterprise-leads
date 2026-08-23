/**
 * Reads leads from the Supabase `leads` table and manages a two-phase
 * outreach cycle:
 *
 *   1. DRAFT — when a lead is due for its next touch, create a Gmail
 *      DRAFT (not a send) and sync the drafted subject/body into Notion's
 *      "Drafted Message" field. Nothing goes out yet.
 *   2. DETECT — on a later run, check whether that draft is still sitting
 *      in the Gmail Drafts folder. If it's gone, treat it as sent: advance
 *      the lead's sequence_step, update Notion, and the lead becomes
 *      eligible for its next touch after the usual delay.
 *
 * Gmail can't distinguish "you sent it" from "you deleted it" — both just
 * make the draft disappear. This script assumes "gone = sent". If you
 * don't want to send a drafted touch, leave it alone rather than deleting
 * it; an untouched draft just pauses that lead harmlessly.
 *
 * Touch 1 differs by need_type (settings.outreach.touch_sets).
 * Touches 2+ are shared copy (settings.outreach.followups) with an
 * {offer_phrase} placeholder that still reflects the right offer.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if any are
 * missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { createDraft, draftStillPending } = require('./lib/gmail');

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

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

const OFFER_PHRASES = {
  website: 'the tech and strategy support we offer',
  social: 'the tech and strategy support we offer',
  both: 'the tech and strategy support we offer',
  reciprocal_link: 'a reciprocal link',
  research_contact: 'GlobalAggregate as a research tool',
  governance_audit: 'the AI Governance Readiness Audit',
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

async function fetchEligibleLeads() {
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

async function notionPatch(pageId, properties) {
  if (!NOTION_TOKEN || !pageId) return;
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) console.error(`Notion property update failed: ${await res.text()}`);
}

async function notionComment(pageId, text) {
  if (!NOTION_TOKEN || !pageId) return;
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }],
    }),
  }).catch(() => {});
}

async function syncDraftToNotion(lead, step, subject, bodyText) {
  await notionPatch(lead.notion_page_id, {
    'Drafted Message': { rich_text: [{ text: { content: `Subject: ${subject}\n\n${bodyText}`.slice(0, 1990) } }] },
  });
  await notionComment(
    lead.notion_page_id,
    `[Automation] Touch ${step} drafted in Gmail on ${new Date().toLocaleDateString()}. Review and send from your Gmail Drafts folder — nothing goes out until you hit Send.`
  );
}

async function syncSentToNotion(lead, step) {
  await notionPatch(lead.notion_page_id, {
    'Outreach Step': { number: step },
    'Last Outreach': { date: { start: new Date().toISOString().slice(0, 10) } },
  });
  await notionComment(lead.notion_page_id, `[Automation] Touch ${step} sent (detected via Gmail Drafts folder).`);
}

// A pending draft from a prior run: check whether it's still sitting
// unreviewed, or gone (assumed sent — see file header).
async function checkPendingDraft(lead) {
  const stillPending = await draftStillPending(lead.gmail_draft_id);
  if (stillPending) return 'pending';

  const step = lead.sequence_step + 1; // the step that was drafted
  const isLastTouch = step === totalSteps();
  const updates = {
    sequence_step: step,
    last_contacted: new Date().toISOString(),
    status: isLastTouch ? 'cold' : 'contacted',
    gmail_draft_id: null,
  };
  await supabase.from('leads').update(updates).eq('id', lead.id);
  await syncSentToNotion(lead, step);
  return 'sent';
}

// Build and create a new draft for a lead's next due touch.
async function draftTouch(lead) {
  const nextStep = lead.sequence_step + 1;
  const touch = touchForStep(lead, nextStep);
  const offerPhrase = OFFER_PHRASES[lead.need_type] || OFFER_PHRASES.website;

  const vars = {
    business_name: lead.business_name,
    sender_name: config.sender_name,
    issue_line: issueLine(lead),
    offer_phrase: offerPhrase,
    context: lead.outreach_context ? `${lead.outreach_context} ` : '',
  };
  const subject = fillTemplate(touch.subject, vars);
  const bodyText = fillTemplate(touch.body, vars);
  const threadedSubject = nextStep > 1 ? `Re: ${subject}` : subject;

  const html = `
    <div style="font-family:sans-serif; font-size:15px; line-height:1.5; color:#1a1a1a;">
      ${bodyText.split('\n').map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('')}
    </div>`;

  const isTest = config.test_mode === true;
  // A lead whose own email already IS the test recipient is a deliberate
  // synthetic test lead (see the one-off test-lead flow) — safe to track
  // fully even while global test_mode is on, since it was never going to
  // reach a real business either way. Only skip tracking for a REAL lead
  // being redirected away from its actual inbox.
  const isSyntheticTestLead = lead.email === config.test_recipient_email;
  const skipTracking = isTest && !isSyntheticTestLead;

  const toAddress = skipTracking ? config.test_recipient_email : lead.email;
  const finalSubject = isTest ? `[TEST for ${lead.business_name}, ${lead.need_type}, step ${nextStep}] ${threadedSubject}` : threadedSubject;
  const replyTo = config.reply_to_email && !config.reply_to_email.startsWith('YOUR_') ? config.reply_to_email : undefined;
  const threadId = nextStep > 1 ? lead.gmail_thread_id : undefined;

  const draft = await createDraft({ to: toAddress, subject: finalSubject, html, replyTo, threadId });

  if (skipTracking) {
    console.log(`[TEST] Created a preview draft for ${lead.business_name} (step ${nextStep}) — not tracked, won't affect sequence state.`);
    return;
  }

  const draftUpdates = { gmail_draft_id: draft.id };
  if (nextStep === 1 && draft.message && draft.message.threadId) {
    draftUpdates.gmail_thread_id = draft.message.threadId;
  }
  await supabase.from('leads').update(draftUpdates).eq('id', lead.id);
  await syncDraftToNotion(lead, nextStep, subject, bodyText);
}

async function run() {
  config = await loadSetting(supabase, 'outreach');

  if (config.sender_name.startsWith('YOUR_')) {
    console.log('outreach-sequencer: settings.outreach still has a placeholder sender_name — skipping run.');
    return;
  }

  const leads = await fetchEligibleLeads();

  let checked = 0;
  let detectedSent = 0;
  let newDrafts = 0;

  for (const lead of leads) {
    if (lead.gmail_draft_id) {
      checked++;
      const outcome = await checkPendingDraft(lead);
      if (outcome === 'sent') detectedSent++;
      continue;
    }
    if (newDrafts >= config.max_sends_per_run) continue;
    if (!isDue(lead)) continue;
    await draftTouch(lead);
    newDrafts++;
  }

  console.log(
    `outreach-sequencer: ${leads.length} eligible. ${checked} pending draft(s) checked (${detectedSent} detected sent). ${newDrafts} new draft(s) created this run.${config.test_mode ? ' [TEST MODE]' : ''}`
  );
}

run().catch((err) => {
  console.error('outreach-sequencer failed:', err);
  process.exit(1);
});
