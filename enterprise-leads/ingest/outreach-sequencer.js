/**
 * Reads leads from the Supabase `leads` table and manages a hybrid
 * outreach cycle:
 *
 *   - TOUCH 1 (first contact with a new lead) is always drafted, never
 *     auto-sent without approval. A Gmail DRAFT gets created and synced to
 *     Notion's "Drafted Message" + "Offer" fields (see the "Outreach
 *     Approvals" view). On a later run, if the lead's "Approve" checkbox
 *     is ticked in Notion, the script sends that exact Gmail draft. You can
 *     also still send it by hand from Gmail; a draft that's gone is
 *     assumed sent (Gmail can't tell "you sent it" apart from "you
 *     deleted it").
 *   - TOUCHES 2-6 (follow-ups) auto-send once due, no draft step. You
 *     approved this lead once at touch 1, so follow-ups go out on their
 *     own until the lead replies (check-replies.js sets status 'replied',
 *     which drops it out of fetchEligibleLeads) or opts out (an opt-out
 *     is a reply, so it stops the same way).
 *
 * Every touch carries an opt-out line. Business service pitches
 * (BUSINESS_NEED_TYPES) also carry settings.outreach.physical_address, as
 * CAN-SPAM requires; the address is private and never goes anywhere else.
 * The run skips entirely until that address is set.
 *
 * If you don't want a drafted touch-1 to send, just leave "Approve"
 * unticked — the draft pauses that lead harmlessly.
 *
 * Touch 1 differs by need_type (settings.outreach.touch_sets).
 * Touches 2+ are shared copy (settings.outreach.followups) with an
 * {offer_phrase} placeholder that still reflects the right offer —
 * EXCEPT for website/social/both leads from touch 3 onward, which pivot
 * to the Automation Readiness Audit pitch (settings.outreach.automation_pivot)
 * once they've gone quiet on the initial menu pitch. See touchForStep().
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if any are
 * missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { createDraft, draftStillPending, sendDraft, sendGmail } = require('./lib/gmail');

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

// Wade Capital service pitches to businesses — the only emails that carry
// the mailing address (GlobalAggregate researcher/link outreach does not).
const BUSINESS_NEED_TYPES = ['website', 'social', 'both', 'governance_audit'];

// Short human label shown in Notion's "Offer" field so the approval view
// says plainly what each draft is pitching.
const OFFER_LABELS = {
  website: 'Website studio',
  social: 'Social media management',
  both: 'Website studio + social media',
  reciprocal_link: 'GlobalAggregate reciprocal link',
  research_contact: 'GlobalAggregate research tool',
  governance_audit: 'Legal AI: AI Governance Readiness Audit',
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
  // Automation Readiness Audit pivot: once a general small-business lead
  // (website/social/both — not Legal AI, not GlobalAggregate) has gone
  // quiet past the intro + one bump, later touches narrow the ask to a
  // single low-commitment deliverable instead of repeating a generic
  // "just checking in." Leaves config.followups untouched for everyone
  // else, and falls back to it automatically if the pivot list is ever
  // exhausted or unset.
  const pivot = config.automation_pivot;
  if (pivot && pivot.eligible_need_types.includes(lead.need_type) && step >= pivot.start_step) {
    const pivotTouch = pivot.touches[step - pivot.start_step];
    if (pivotTouch) return pivotTouch;
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

// Touch 1 only sends when the lead's "Approve" checkbox is ticked in
// Notion. Missing token/page or any API error reads as "not approved".
async function notionApproved(pageId) {
  if (!NOTION_TOKEN || !pageId) return false;
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!res.ok) return false;
  const page = await res.json();
  return page.properties?.Approve?.checkbox === true;
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
    Offer: { rich_text: [{ text: { content: OFFER_LABELS[lead.need_type] || OFFER_LABELS.website } }] },
  });
  await notionComment(
    lead.notion_page_id,
    `[Automation] Touch ${step} drafted in Gmail on ${new Date().toLocaleDateString()}. Tick "Approve" to have it sent on the next run (to change the wording, edit the Gmail draft). Nothing goes out until you approve.`
  );
}

async function syncSentToNotion(lead, step) {
  await notionPatch(lead.notion_page_id, {
    'Outreach Step': { number: step },
    'Last Outreach': { date: { start: new Date().toISOString().slice(0, 10) } },
  });
  await notionComment(lead.notion_page_id, `[Automation] Touch ${step} sent.`);
}

// Shared by both the draft path (touch 1) and the auto-send path
// (touches 2+) — builds the subject/body/html for whatever touch is due.
function buildMessage(lead, nextStep) {
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
  // CAN-SPAM: opt-out line on every touch. The mailing address is private and
  // only goes to businesses we pitch Wade Capital services to.
  const addressLine = BUSINESS_NEED_TYPES.includes(lead.need_type) ? `${config.physical_address}\n` : '';
  const bodyText = `${fillTemplate(touch.body, vars)}\n\n--\n${addressLine}Not interested? Reply "unsubscribe" and I won't email you again.`;
  const threadedSubject = nextStep > 1 ? `Re: ${subject}` : subject;
  const html = `
    <div style="font-family:sans-serif; font-size:15px; line-height:1.5; color:#1a1a1a;">
      ${bodyText.split('\n').map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('')}
    </div>`;

  return { subject, bodyText, threadedSubject, html };
}

// A lead whose own email already IS the test recipient is a deliberate
// synthetic test lead (see the one-off test-lead flow) — safe to track
// fully even while global test_mode is on, since it was never going to
// reach a real business either way. Only skip tracking for a REAL lead
// being redirected away from its actual inbox.
function trackingDecision(lead) {
  const isTest = config.test_mode === true;
  const isSyntheticTestLead = lead.email === config.test_recipient_email;
  const skipTracking = isTest && !isSyntheticTestLead;
  return { isTest, skipTracking, toAddress: skipTracking ? config.test_recipient_email : lead.email };
}

// A pending draft from a prior run: send it if approved in Notion, leave
// it if not, or treat it as sent by hand if it's gone (see file header).
async function checkPendingDraft(lead) {
  let sent = null;
  if (await draftStillPending(lead.gmail_draft_id)) {
    if (!(await notionApproved(lead.notion_page_id))) return 'pending';
    sent = await sendDraft(lead.gmail_draft_id);
  }

  const step = lead.sequence_step + 1; // the step that was drafted
  const isLastTouch = step === totalSteps();
  const updates = {
    sequence_step: step,
    last_contacted: new Date().toISOString(),
    status: isLastTouch ? 'cold' : 'contacted',
    gmail_draft_id: null,
  };
  if (sent?.threadId) updates.gmail_thread_id = sent.threadId;
  await supabase.from('leads').update(updates).eq('id', lead.id);
  await syncSentToNotion(lead, step);
  return sent ? 'approved' : 'sent';
}

// Touch 1 only: create a Gmail draft, don't send, wait for a human.
async function draftTouch(lead) {
  const nextStep = 1;
  const { subject, bodyText, threadedSubject, html } = buildMessage(lead, nextStep);
  const { isTest, skipTracking, toAddress } = trackingDecision(lead);

  const finalSubject = isTest ? `[TEST for ${lead.business_name}, ${lead.need_type}, step ${nextStep}] ${threadedSubject}` : threadedSubject;
  const replyTo = config.reply_to_email && !config.reply_to_email.startsWith('YOUR_') ? config.reply_to_email : undefined;

  const draft = await createDraft({ to: toAddress, subject: finalSubject, html, replyTo });

  if (skipTracking) {
    console.log(`[TEST] Created a preview draft for ${lead.business_name} (step ${nextStep}) — not tracked, won't affect sequence state.`);
    return;
  }

  const draftUpdates = { gmail_draft_id: draft.id };
  if (draft.message && draft.message.threadId) draftUpdates.gmail_thread_id = draft.message.threadId;
  await supabase.from('leads').update(draftUpdates).eq('id', lead.id);
  await syncDraftToNotion(lead, nextStep, subject, bodyText);
}

// Touches 2-6 only: send immediately, no draft step. You already
// approved this lead once at touch 1.
async function sendFollowupTouch(lead) {
  const nextStep = lead.sequence_step + 1;
  const { threadedSubject, html } = buildMessage(lead, nextStep);
  const { isTest, skipTracking, toAddress } = trackingDecision(lead);

  const finalSubject = isTest ? `[TEST for ${lead.business_name}, ${lead.need_type}, step ${nextStep}] ${threadedSubject}` : threadedSubject;
  const replyTo = config.reply_to_email && !config.reply_to_email.startsWith('YOUR_') ? config.reply_to_email : undefined;

  await sendGmail({ to: toAddress, subject: finalSubject, html, replyTo, threadId: lead.gmail_thread_id });

  if (skipTracking) {
    console.log(`[TEST] Sent a preview follow-up for ${lead.business_name} (step ${nextStep}) — not tracked.`);
    return;
  }

  const isLastTouch = nextStep === totalSteps();
  await supabase.from('leads').update({
    sequence_step: nextStep,
    last_contacted: new Date().toISOString(),
    status: isLastTouch ? 'cold' : 'contacted',
  }).eq('id', lead.id);
  await syncSentToNotion(lead, nextStep);
}

async function run() {
  config = await loadSetting(supabase, 'outreach');

  if (config.sender_name.startsWith('YOUR_')) {
    console.log('outreach-sequencer: settings.outreach still has a placeholder sender_name — skipping run.');
    return;
  }
  if (!config.physical_address || config.physical_address.startsWith('YOUR_')) {
    console.log('outreach-sequencer: settings.outreach.physical_address is not set (required by CAN-SPAM) — skipping run.');
    return;
  }

  const leads = await fetchEligibleLeads();

  let checked = 0;
  let detectedSent = 0;
  let approvedSent = 0;
  let newDrafts = 0;
  let followupsSent = 0;

  let skipped = 0;
  let rateLimited = 0;

  for (const lead of leads) {
    try {
      if (lead.gmail_draft_id) {
        checked++;
        const outcome = await checkPendingDraft(lead);
        if (outcome === 'sent') detectedSent++;
        if (outcome === 'approved') approvedSent++;
        continue;
      }
      if (!isDue(lead)) continue;

      const nextStep = lead.sequence_step + 1;
      if (nextStep === 1) {
        if (newDrafts >= (config.max_new_drafts_per_run ?? 25)) continue;
        await draftTouch(lead);
        newDrafts++;
      } else {
        if (followupsSent >= (config.max_followups_per_run ?? 30)) continue;
        await sendFollowupTouch(lead);
        followupsSent++;
      }
    } catch (err) {
      const isRateLimit = /rateLimitExceeded|RESOURCE_EXHAUSTED|Quota exceeded/i.test(err.message);
      if (isRateLimit) {
        // Transient — Gmail's per-minute quota tripped, likely because there
        // were enough leads left to check that we ran through the budget.
        // Every remaining check this run would fail the same way, so stop
        // here rather than burning through them one at a time. Leave this
        // lead (and everything behind it) completely untouched — it'll be
        // re-checked from where we left off next run.
        rateLimited++;
        console.error(`outreach-sequencer: hit Gmail's rate limit while checking "${lead.business_name}" — stopping this run early. ${leads.length - checked - newDrafts - followupsSent} lead(s) left unchecked, will retry next run.`);
        break;
      }
      // One bad record (e.g. a malformed scraped email) should never
      // take down every other lead behind it in this run. Log it,
      // clear the email so it falls out of eligibility and gets
      // re-attempted by enrich-emails.mjs, and move on.
      skipped++;
      console.error(`outreach-sequencer: skipping "${lead.business_name}" (id ${lead.id}) after error: ${err.message}`);
      try {
        await supabase.from('leads').update({ email: null }).eq('id', lead.id);
      } catch (cleanupErr) {
        console.error(`outreach-sequencer: also failed to clear email for "${lead.business_name}": ${cleanupErr.message}`);
      }
      try {
        await notionComment(
          lead.notion_page_id,
          `[Automation] Outreach failed for this lead (${err.message}). Email cleared so it can be re-checked by the enrichment step — if it fails again, the email likely needs to be fixed by hand.`
        );
      } catch {
        // notionComment failing is non-critical; already logged via the outer skip.
      }
    }
  }

  if (rateLimited > 0) {
    console.log(`outreach-sequencer: stopped early after a rate-limit error — see log above.`);
  }
  if (skipped > 0) {
    console.log(`outreach-sequencer: ${skipped} lead(s) skipped due to errors this run — see log above for details.`);
  }
  console.log(
    `outreach-sequencer: ${leads.length} eligible. ${checked} pending touch-1 draft(s) checked (${approvedSent} sent after Notion approval, ${detectedSent} sent by hand). ${newDrafts}/${config.max_new_drafts_per_run ?? 25} new touch-1 draft(s) created, ${followupsSent}/${config.max_followups_per_run ?? 30} follow-up(s) auto-sent this run.${config.test_mode ? ' [TEST MODE]' : ''}`
  );
}

run().catch((err) => {
  console.error('outreach-sequencer failed:', err);
  process.exit(1);
});
