/**
 * Sends outreach to leads in the Supabase `leads` table, fully
 * automatically, with guard rails.
 *
 * What changed (Sept 2026): touch 1 used to be saved as a Gmail DRAFT
 * for a human to send. That step is gone — every touch now sends on its
 * own, within daily caps. Safety checks run right before each send:
 *
 *   1. Email check (lib/email-quality.js): placeholder addresses and
 *      domains with no mail server are never sent to.
 *   2. Leftover drafts from the old flow: if a touch-1 draft still
 *      exists it was never sent, so it is deleted and replaced by the
 *      new email (the old copy lacks the required footer). If the
 *      draft is gone, it was already sent by hand, so the lead just
 *      moves forward. Either way nobody gets the same email twice.
 *   3. Daily caps: `max_new_sends_per_run` (first emails) and
 *      `max_followups_per_run` keep one free Gmail inbox inside volumes
 *      that don't trip spam filters.
 *   4. Legal footer: every email carries an opt-out line, and Wade
 *      Capital service pitches (BUSINESS_NEED_TYPES) also carry the
 *      mailing address (U.S. CAN-SPAM Act). The address lives only in the
 *      private `business_mailing_address` settings row (a JSON string),
 *      never in this public repo. If it isn't set, NOTHING sends.
 *   5. No approval step: every email sends on its own (Sept 30, 2026,
 *      at Deven's request). Notion still gets a copy of each first email
 *      in "Drafted Message" as a record, but nothing waits on it.
 *
 * Which email a lead gets:
 *   - touch 1 is picked by need_type (settings.outreach.touch_sets).
 *     Leads with NO website get `touch_sets.no_website` when a
 *     `preview_base_url` is set — that email links to a free mockup of
 *     a site for their business (see preview.html on the Wade Capital
 *     site). Otherwise they get the regular `website` touch.
 *   - a category with its own touch set (e.g. `touch_sets.restaurant`,
 *     the pizza-shop starter menu) gets that email and its
 *     `followup_sets.<category>` follow-ups, even if the category is in
 *     skip_categories (that list only skips the generic pitch).
 *   - touches 2+ are shared follow-ups (settings.outreach.followups),
 *     unless settings.outreach.followup_sets has a list for that
 *     need_type (e.g. `buyer_intro` for real estate investors), and
 *     website/social/both leads switch to the Automation Readiness Audit
 *     pitch (settings.outreach.automation_pivot) from `start_step` on.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if missing.
 * Run with DRY_RUN=1 to print what WOULD send without sending anything.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { sendGmail, deleteDraft, draftStillPending, recentSendLimitHit } = require('./lib/gmail');
const { fetchSignals, pageSpeed } = require('./lib/site-signals');
const { checkSendable } = require('./lib/email-quality');
const { previewUrl: buildPreviewUrl } = require('./lib/preview');
const { createRunLog } = require('./lib/run-log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || (!DRY_RUN && (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN))) {
  console.log('outreach-sequencer: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const runLog = createRunLog(supabase, DRY_RUN ? 'outreach-sequencer-dry-run' : 'outreach-sequencer');
let config;
let mailingAddress; // private: from the business_mailing_address settings row

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

const OFFER_PHRASES = {
  website: 'a website refresh',
  social: 'automated social media posting',
  both: 'a website refresh and automated social posting',
  reciprocal_link: 'a reciprocal link',
  research_contact: 'GlobalAggregate as a research tool',
  governance_audit: 'the AI Governance Readiness Audit',
  buyer_intro: 'off-market Baltimore deals',
};

// Wade Capital service pitches to businesses: the only emails that carry
// the mailing address (GlobalAggregate researcher/link outreach does not).
const BUSINESS_NEED_TYPES = ['website', 'social', 'both', 'governance_audit', 'buyer_intro'];

// Pitches that are never swapped for the no-website mockup email.
const NO_MOCKUP_NEED_TYPES = ['governance_audit', 'buyer_intro', 'reciprocal_link', 'research_contact'];

// Short label for Notion's "Offer" field.
const OFFER_LABELS = {
  website: 'Website studio',
  social: 'Social media management',
  both: 'Website studio + social media',
  reciprocal_link: 'GlobalAggregate reciprocal link',
  research_contact: 'GlobalAggregate research tool',
  governance_audit: 'Legal AI: AI Governance Readiness Audit',
  buyer_intro: 'Real estate: cash-buyer intro',
};

function issueLine(lead) {
  if (lead.need_type === 'social') return "doesn't link to any social media accounts";
  if (!lead.site_url) return "doesn't seem to have a website";
  // A footer copyright 3+ years old is the most specific thing we can point to.
  if (lead.copyright_year && lead.copyright_year <= new Date().getFullYear() - 3) {
    const extra = !lead.mobile_ok ? " and doesn't adjust for phone screens" : !lead.has_ssl ? ' and shows a "not secure" warning in some browsers' : '';
    return `still shows © ${lead.copyright_year} in the footer${extra}`;
  }
  // Google's own speed test: Largest Contentful Paint over 4 s counts as "poor".
  if (lead.load_seconds >= 4) return `takes about ${Math.round(lead.load_seconds)} seconds to load on a phone (I ran Google's free speed test)`;
  if (!lead.mobile_ok && !lead.has_ssl) return "doesn't adjust for phones and shows a \"not secure\" warning in some browsers";
  if (!lead.mobile_ok) return "doesn't adjust for phone screens";
  if (!lead.has_ssl) return "shows a \"not secure\" warning in some browsers (no SSL certificate)";
  if (lead.has_tel === false) return "doesn't have a tap-to-call button, so people on phones have to copy your number by hand";
  if (lead.has_description === false) return "is missing the short description Google shows under your name in search results";
  if (lead.need_type === 'both') return "doesn't link to any social media accounts";
  return 'could use a refresh';
}

// Website pitches carry a mockup link: a sample site built from the
// business's Google listing. Sent to businesses with no site AND to ones
// whose site needs work (a concrete sample gets far more replies than
// "want me to send a mockup?"). Also after an AI call, where we promised one.
const MOCKUP_NEED_TYPES = ['website', 'both'];

function previewUrl(lead) {
  const wantsMockup = MOCKUP_NEED_TYPES.includes(lead.need_type) || lead.email_enrichment_result === 'from_call' || !lead.site_url;
  if (!wantsMockup || NO_MOCKUP_NEED_TYPES.includes(lead.need_type)) return null;
  return buildPreviewUrl({ ...lead, site_url: null }, config.preview_base_url);
}

// Categories with their own email (settings.outreach.touch_sets.<category>).
function categoryTouches(lead) {
  return lead.category && config.touch_sets[lead.category];
}

function followupsFor(lead) {
  const sets = config.followup_sets || {};
  return (categoryTouches(lead) && sets[lead.category]) || sets[lead.need_type] || config.followups;
}

// Total touches for THIS lead (need types can have their own follow-ups).
function totalSteps(lead) {
  return 1 + (lead ? followupsFor(lead) : config.followups).length;
}

// Longest sequence across all need types, for the eligibility query.
function maxSteps() {
  const lengths = [config.followups.length, ...Object.values(config.followup_sets || {}).map((f) => f.length)];
  return 1 + Math.max(...lengths);
}

function touchForStep(lead, step) {
  if (step === 1) {
    // They gave us this email on an AI call and asked for the mockup.
    if (lead.email_enrichment_result === 'from_call' && config.touch_sets.after_call) {
      return config.touch_sets.after_call[0];
    }
    if (categoryTouches(lead)) return categoryTouches(lead)[0];
    if (!lead.site_url && config.preview_base_url && config.touch_sets.no_website && !NO_MOCKUP_NEED_TYPES.includes(lead.need_type)) {
      return config.touch_sets.no_website[0];
    }
    const set = config.touch_sets[lead.need_type] || config.touch_sets.website;
    return set[0];
  }
  const pivot = config.automation_pivot;
  if (pivot && !categoryTouches(lead) && pivot.eligible_need_types.includes(lead.need_type) && step >= pivot.start_step) {
    const pivotTouch = pivot.touches[step - pivot.start_step];
    if (pivotTouch) return pivotTouch;
  }
  return followupsFor(lead)[step - 2];
}

async function fetchEligibleLeads() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['new', 'contacted'])
    .not('email', 'is', null)
    .neq('email', '')
    .not('need_type', 'is', null)
    .lt('sequence_step', maxSteps())
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw error;
  return leads || [];
}

function isDue(lead) {
  const nextStep = lead.sequence_step + 1;
  if (nextStep > totalSteps(lead)) return false;
  const touch = touchForStep(lead, nextStep);
  if (!touch) return false;
  if (lead.sequence_step === 0) return true;
  if (!lead.last_contacted) return true;
  const daysSince = (Date.now() - new Date(lead.last_contacted).getTime()) / 86400000;
  return daysSince >= touch.delay_days;
}

// Supabase returns errors instead of throwing — the old code ignored
// them, which is how a lead could silently fail to advance.
// Retries, because a failed save right AFTER an email goes out would
// leave the lead looking unsent and it could be emailed again next run.
async function updateLead(id, fields) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { error } = await supabase.from('leads').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
    if (!error) return;
    lastError = error;
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error(`Supabase update failed after retries (lead ${id}): ${lastError.message}`);
}

async function notionPatch(pageId, properties) {
  if (!NOTION_TOKEN || !pageId || DRY_RUN) return;
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) console.error(`Notion property update failed: ${await res.text()}`);
}

async function notionComment(pageId, text) {
  if (!NOTION_TOKEN || !pageId || DRY_RUN) return;
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] } }],
    }),
  }).catch(() => {});
}

async function syncSentToNotion(lead, step, subject, bodyText) {
  const props = {
    'Outreach Step': { number: step },
    'Last Outreach': { date: { start: new Date().toISOString().slice(0, 10) } },
  };
  if (step === 1 && bodyText) {
    props['Drafted Message'] = { rich_text: [{ text: { content: `Subject: ${subject}\n\n${bodyText}`.slice(0, 1990) } }] };
    const offer = categoryTouches(lead) ? `Starter menu (${lead.category})` : OFFER_LABELS[lead.need_type] || OFFER_LABELS.website;
    props.Offer = { rich_text: [{ text: { content: offer } }] };
  }
  await notionPatch(lead.notion_page_id, props);
  await notionComment(lead.notion_page_id, `[Automation] Touch ${step} sent ${new Date().toLocaleDateString('en-US')}.`);
}

function footer(lead) {
  const addressLine = BUSINESS_NEED_TYPES.includes(lead.need_type) ? `Wade Capital LLC, ${mailingAddress}\n` : '';
  return `\n\n--\n${addressLine}If you'd rather not hear from me, just reply "unsubscribe" and I won't email again.`;
}

function buildMessage(lead, nextStep) {
  const touch = touchForStep(lead, nextStep);
  const vars = {
    business_name: lead.business_name,
    sender_name: (config.sender_name || '').trim(),
    issue_line: issueLine(lead),
    offer_phrase: OFFER_PHRASES[lead.need_type] || OFFER_PHRASES.website,
    context: lead.outreach_context ? `${lead.outreach_context} ` : '',
    preview_url: previewUrl(lead) || '',
    // For follow-ups: repeats the mockup link where there is one, else nothing.
    mockup_line: previewUrl(lead) ? `\n\nHere's the sample site I made for ${lead.business_name} again: ${previewUrl(lead)}` : '',
    site_url: lead.site_url || '',
    // First emails: one line offering the sample site, only when there is one.
    sample_line: previewUrl(lead) ? `\n\nI also put together a free sample site for ${lead.business_name}: ${previewUrl(lead)}` : '',
    demo_call_line: config.demo_call_url ? `\n\nHere's a 1-minute recording of our AI phone agent taking a pizza order: ${config.demo_call_url}` : '',
  };
  // Follow-ups reuse the FIRST email's subject ("Re: ...") so Gmail keeps
  // the whole sequence in one thread on the recipient's side.
  const subject = fillTemplate(nextStep > 1 ? touchForStep(lead, 1).subject : touch.subject, vars);
  let bodyText = fillTemplate(touch.body, vars).replace(/\n{3,}/g, '\n\n') + footer(lead);
  if (nextStep === 1 && lead.owner_first) bodyText = bodyText.replace(/^Hi,/, `Hi ${lead.owner_first},`);
  const threadedSubject = nextStep > 1 ? `Re: ${subject}` : subject;
  return { subject, bodyText, threadedSubject };
}

function trackingDecision(lead) {
  const isTest = config.test_mode === true;
  const isSyntheticTestLead = lead.email === config.test_recipient_email;
  const skipTracking = isTest && !isSyntheticTestLead;
  return { isTest, skipTracking, toAddress: skipTracking ? config.test_recipient_email : lead.email };
}

// Called when the pre-send email check fails.
async function rejectEmail(lead, email, reason) {
  console.log(`  ✗ ${lead.business_name}: not sending to "${email}" (${reason}).`);
  if (DRY_RUN) return;
  if (lead.sequence_step === 0) {
    // Never contacted — clear the bad address so enrichment can look for
    // a real one after its retry window.
    await updateLead(lead.id, {
      email: null,
      gmail_draft_id: null,
      email_enrichment_result: `rejected_${reason}`,
      email_enrichment_attempted_at: new Date().toISOString(),
    });
  } else {
    await updateLead(lead.id, { status: 'bad_email', email_enrichment_result: `rejected_${reason}` });
  }
}

async function advanceAfterSend(lead, step, extra = {}) {
  const isLastTouch = step >= totalSteps(lead);
  await updateLead(lead.id, {
    sequence_step: step,
    last_contacted: new Date().toISOString(),
    status: isLastTouch ? 'cold' : 'contacted',
    gmail_draft_id: null,
    reply_kind: null, // clears a past 'not_sent' so a future limit bounce is handled again
    ...extra,
  });
}

// A touch-1 draft left over from the old manual flow.
// If it's gone, it was sent by hand: just move the lead forward.
// If it's still there, it was never sent. Its old copy has no mailing
// address or opt-out line, so delete it and send the new email instead.
// Returns 'sent_now' | 'already_sent' | 'rejected'.
async function resolveLegacyDraft(lead) {
  const stillThere = DRY_RUN ? true : await draftStillPending(lead.gmail_draft_id);
  if (!stillThere) {
    await advanceAfterSend(lead, 1);
    await syncSentToNotion(lead, 1);
    return 'already_sent';
  }
  if (!DRY_RUN) {
    await deleteDraft(lead.gmail_draft_id); // throws on failure, so we never send while the old draft survives
    await updateLead(lead.id, { gmail_draft_id: null, gmail_thread_id: null });
  }
  lead.gmail_draft_id = null;
  lead.gmail_thread_id = null;
  const ok = await sendTouch(lead);
  return ok ? 'sent_now' : 'rejected';
}

async function sendTouch(lead) {
  const nextStep = lead.sequence_step + 1;
  const check = await checkSendable(lead.email);
  if (!check.ok) {
    await rejectEmail(lead, lead.email, check.reason);
    return false;
  }
  if (check.email !== lead.email && !DRY_RUN) await updateLead(lead.id, { email: check.email });
  lead.email = check.email;

  // First email only: read the homepage for the owner's name and an old copyright year.
  // Agency-built sites already pay someone for their website: skip them for good.
  // The issue we name must be true: https and the phone layout are checked
  // live here (the stored flags came from the listing link and were often wrong).
  if (nextStep === 1 && lead.site_url) {
    const sig = await fetchSignals(lead.site_url);
    if (!sig.reachable) {
      console.log(`  - ${lead.business_name}: site didn't load; skipping.`);
      if (!DRY_RUN) await updateLead(lead.id, { email_enrichment_result: 'site_unreachable' });
      return false;
    }
    lead.has_ssl = sig.secure;
    lead.mobile_ok = sig.mobileOk;
    if (sig.builtBy && lead.need_type !== 'social') {
      console.log(`  - ${lead.business_name}: site built by ${sig.builtBy}; skipping.`);
      if (!DRY_RUN) await updateLead(lead.id, { email_enrichment_result: 'agency_managed' });
      return false;
    }
    lead.owner_first = sig.ownerFirst;
    lead.copyright_year = sig.copyrightYear;
    lead.has_tel = sig.hasTel;
    lead.has_description = sig.hasDescription;
    // The speed test is slow, so only run it when nothing cheaper turned up.
    if (issueLine(lead) === 'could use a refresh' || issueLine(lead).startsWith("doesn't have a tap") || issueLine(lead).startsWith('is missing')) {
      lead.load_seconds = await pageSpeed(lead.site_url);
    }
    if (!DRY_RUN) await updateLead(lead.id, { has_ssl: sig.secure, mobile_ok: sig.mobileOk });
    // Only email when there's something real and specific to point to.
    if (!categoryTouches(lead) && ['website', 'both'].includes(lead.need_type) && issueLine(lead) === 'could use a refresh') {
      console.log(`  - ${lead.business_name}: site checks out fine; no clear issue, skipping.`);
      if (!DRY_RUN) await updateLead(lead.id, { email_enrichment_result: 'no_clear_issue' });
      return false;
    }
  }

  const { subject, bodyText, threadedSubject } = buildMessage(lead, nextStep);
  const { isTest, skipTracking, toAddress } = trackingDecision(lead);
  const finalSubject = isTest ? `[TEST for ${lead.business_name}, step ${nextStep}] ${threadedSubject}` : threadedSubject;

  if (DRY_RUN) {
    console.log(`\n  → [dry run] step ${nextStep} to ${toAddress} (${lead.business_name})\n  Subject: ${finalSubject}\n${bodyText.replace(/^/gm, '    ')}\n`);
    return true;
  }

  // A short pause before each send keeps Gmail's per-minute limit happy
  // and makes the sending pattern look less like a blast.
  await new Promise((r) => setTimeout(r, 1500));
  const message = {
    to: toAddress,
    subject: finalSubject,
    text: bodyText,
    replyTo: config.reply_to_email || undefined,
    fromName: config.from_display_name || undefined,
    fromEmail: config.from_display_name ? config.reply_to_email : undefined,
    threadId: nextStep > 1 ? lead.gmail_thread_id || undefined : undefined,
  };
  let sent;
  try {
    sent = await sendGmail(message);
  } catch (err) {
    // Gmail answers 404 when the thread we're replying into no longer
    // exists in this mailbox (e.g. the first email came from the old
    // draft flow and was deleted). Send it as a fresh email instead.
    if (!message.threadId || !/"code":\s*404|notFound/.test(err.message)) throw err;
    sent = await sendGmail({ ...message, threadId: undefined });
    await updateLead(lead.id, { gmail_thread_id: sent.threadId });
  }

  if (skipTracking) {
    console.log(`[TEST] Sent a preview of step ${nextStep} for ${lead.business_name} to the test inbox — not tracked.`);
    return true;
  }
  await advanceAfterSend(lead, nextStep, nextStep === 1 ? { gmail_thread_id: sent.threadId } : {});
  await syncSentToNotion(lead, nextStep, subject, bodyText);
  return true;
}

async function run() {
  config = await loadSetting(supabase, 'outreach');

  mailingAddress = await loadSetting(supabase, 'business_mailing_address').catch(() => null);
  if (typeof mailingAddress !== 'string' || !mailingAddress.trim() || /^YOUR_/i.test(mailingAddress)) {
    console.log('outreach-sequencer: the business_mailing_address settings row is not set. U.S. law (CAN-SPAM) requires a mailing address in commercial email, so nothing will send until it is.');
    return;
  }
  mailingAddress = mailingAddress.trim();

  // Gmail bounced sends for the daily limit in the last 24 h: sending more only
  // bounces more (and floods the inbox). Wait for the limit to reset.
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const { count: limitBounces } = await supabase.from('leads').select('id', { count: 'exact', head: true })
    .eq('reply_kind', 'not_sent').gte('updated_at', dayAgo);
  if (!DRY_RUN && (limitBounces > 0 || (await recentSendLimitHit()))) {
    console.log('outreach-sequencer: Gmail reported its daily sending limit in the last 24 hours. Skipping this run.');
    await runLog.finish('skipped: Gmail sending limit hit in the last 24 hours');
    return;
  }

  const maxNew = config.max_new_sends_per_run ?? 25;
  const maxFollowups = config.max_followups_per_run ?? 25;
  const leads = await fetchEligibleLeads();

  const counts = { legacySent: 0, legacyAlready: 0, newSent: 0, followups: 0, rejected: 0, errors: 0 };

  // Follow-ups first (these people have already heard from us once),
  // then brand-new leads, oldest first.
  const followupLeads = leads.filter((l) => l.sequence_step > 0);
  const firstTouchLeads = leads.filter((l) => l.sequence_step === 0);

  // Categories we no longer target (settings.outreach.skip_categories) don't get first emails.
  const skip = new Set(config.skip_categories || []);
  // Best leads first: law firms (bigger engagements), then no site or a broken one, an address at their own domain.
  const score = (l) => (l.need_type === 'governance_audit' ? 10 : 0) + (!l.site_url ? 3 : 0) + (!l.mobile_ok ? 2 : 0) + (!l.has_ssl ? 1 : 0) + (l.need_type === 'both' ? 1 : 0) +
    (l.site_url && l.email && l.site_url.includes(l.email.split('@')[1]) ? 2 : 0);
  const done = ['agency_managed', 'no_clear_issue', 'site_unreachable'];
  const fresh = firstTouchLeads.filter((l) => (!skip.has(l.category) || categoryTouches(l)) && !done.includes(l.email_enrichment_result))
    .sort((a, b) => score(b) - score(a));
  const queue = [...followupLeads, ...fresh];
  const runStart = Math.floor(Date.now() / 1000);
  let checkedAt = 0;

  for (const lead of queue) {
    // Gmail's limit bounces arrive seconds after a send: check every 10 sends
    // and stop at once, instead of sending the whole batch into a wall.
    const sentSoFar = counts.newSent + counts.legacySent + counts.followups;
    if (!DRY_RUN && sentSoFar >= checkedAt + 10) {
      checkedAt = sentSoFar;
      if (await recentSendLimitHit(runStart)) {
        console.error('outreach-sequencer: Gmail hit its sending limit mid-run — stopping. check-replies will requeue what bounced.');
        counts.stoppedAtLimit = true;
        break;
      }
    }
    try {
      if (lead.sequence_step === 0) {
        if (counts.newSent + counts.legacySent >= maxNew && !lead.gmail_draft_id) continue;
        if (lead.gmail_draft_id) {
          if (counts.newSent + counts.legacySent >= maxNew) {
            // Still resolve drafts that were already sent by hand — that
            // costs no send quota.
            if (DRY_RUN) continue;
            const pending = await draftStillPending(lead.gmail_draft_id);
            if (pending) continue;
          }
          const outcome = await resolveLegacyDraft(lead);
          if (outcome === 'sent_now') counts.legacySent++;
          else if (outcome === 'already_sent') counts.legacyAlready++;
          else counts.rejected++;
          continue;
        }
        const ok = await sendTouch(lead);
        if (ok) counts.newSent++;
        else counts.rejected++;
      } else {
        if (counts.followups >= maxFollowups || !isDue(lead)) continue;
        const ok = await sendTouch(lead);
        if (ok) counts.followups++;
        else counts.rejected++;
      }
    } catch (err) {
      if (/rateLimitExceeded|RESOURCE_EXHAUSTED|Quota exceeded|userRateLimitExceeded/i.test(err.message)) {
        console.error(`outreach-sequencer: Gmail rate limit reached at "${lead.business_name}" — stopping; the rest go out next run.`);
        break;
      }
      counts.errors++;
      console.error(`outreach-sequencer: error on "${lead.business_name}" (id ${lead.id}): ${err.message}`);
      runLog.error(`${lead.business_name} (${lead.id})`, err);
      if (/Supabase update failed after retries/.test(err.message)) {
        console.error('outreach-sequencer: stopping the run — the database is not saving progress, and continuing could double-send.');
        process.exitCode = 1;
        break;
      }
    }
  }

  const summary =
    `${leads.length} eligible. ` +
      `First emails sent: ${counts.newSent} new + ${counts.legacySent} leftover drafts (cap ${maxNew}). ` +
      `Leftover drafts already sent by hand: ${counts.legacyAlready}. Follow-ups: ${counts.followups} (cap ${maxFollowups}). ` +
      `Bad addresses / no clear issue skipped: ${counts.rejected}. Errors: ${counts.errors}.` +
      (counts.stoppedAtLimit ? ' STOPPED EARLY: Gmail sending limit.' : '') +
      (config.test_mode ? ' [TEST MODE]' : '')
  ;
  console.log(`outreach-sequencer${DRY_RUN ? ' [DRY RUN]' : ''}: ${summary}`);
  await runLog.finish(summary);
}

run().catch(async (err) => {
  console.error('outreach-sequencer failed:', err);
  runLog.error('run', err);
  await runLog.finish('run failed');
  process.exit(1);
});
