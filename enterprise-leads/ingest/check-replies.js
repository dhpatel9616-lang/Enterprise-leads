/**
 * Checks every emailed lead's Gmail thread and sorts what came back.
 * Runs BEFORE outreach-sequencer.js each weekday, so anything that came
 * in overnight stops that lead's sequence before the next email fires.
 *
 * The old version treated ANY incoming message as "replied" — including
 * "Delivery Status Notification (Failure)" bounces, which is why most of
 * the leads marked `replied` were actually dead addresses. Each message
 * that isn't ours is now classified:
 *
 *   bounce       → status 'bounced'      (address is dead; lead moves to
 *                                          the call list in the digest)
 *   unsubscribe  → status 'unsubscribed' (never emailed again)
 *   auto-reply   → ignored ("out of office" is not a conversation)
 *   anything else→ status 'replied'      (a human wrote back — go read it)
 *
 * A NEW human reply also emails an alert to settings.outreach.alert_email
 * (default: reply_to_email) with their message, their phone number, a link
 * to the thread and a suggested answer, so Deven can answer within the hour
 * (the workflow runs hourly).
 *
 * `reply_kind` records which one it was. Leads already marked 'replied'
 * by the old logic with no reply_kind get re-checked once automatically,
 * so the old misclassifications fix themselves.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { getOwnEmailAddress, getThreadMessages, sendGmail } = require('./lib/gmail');
const { loadSetting } = require('./lib/settings');
const { createRunLog } = require('./lib/run-log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
  console.log('check-replies: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const runLog = createRunLog(supabase, 'check-replies');

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)|microsoftexchange|bounce/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliver|delivery (has )?failed|failure notice|returned mail|could not be delivered|mail delivery failed|delivery incomplete|message not delivered|address not found/i;
// Gmail refusing OUR send for the daily limit: the email never left, the
// address is fine. The lead is put back one step to be sent again.
const NOT_SENT = /limit for sending|sending limit|message was not sent|sending quota/i;
// Temporary "still trying to deliver" notices are not bounces.
const DELAY_NOTICE = /\(delay\)|delivery (is )?delayed|temporary problem delivering|will retry/i;
// Auto-responders that don't say so in the subject (e.g. "After Hours Message").
const AUTO_TEXT = /after[- ]hours|outside (of )?(our )?(normal |regular )?business hours|this is an automated|automated (response|reply|message)|do not reply to this|you'?ve reached us|we('ll| will) (get back|respond|reply) to you (as soon|shortly|within)|thanks? for (your email|contacting|reaching out)[^.]{0,60}(we|our team) (will|'ll)|ticket (number|#)|case (number|#)/i;
const AUTO_SUBJECT = /out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|away from (my|the) (desk|office)|on vacation|thank you for (your email|contacting|reaching out)|we (have )?received your (message|email)/i;
const UNSUB_TEXT = /\bunsubscribe\b|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|don'?t (email|contact)|not interested|no thanks|no thank you/i;

function header(message, name) {
  return (message.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function classify(message) {
  const from = header(message, 'From');
  const subject = header(message, 'Subject');
  const autoSubmitted = header(message, 'Auto-Submitted');
  const snippet = message.snippet || '';
  if (DELAY_NOTICE.test(subject) || DELAY_NOTICE.test(snippet)) return 'auto';
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject)) return NOT_SENT.test(`${subject} ${snippet}`) ? 'not_sent' : 'bounce';
  if (UNSUB_TEXT.test(snippet) || UNSUB_TEXT.test(subject)) return 'unsubscribe';
  if ((autoSubmitted && autoSubmitted.toLowerCase() !== 'no') || AUTO_SUBJECT.test(subject) || AUTO_TEXT.test(snippet)) return 'auto';
  return 'reply';
}

// Strongest signal wins: a human reply beats an auto-reply, etc.
const RANK = { reply: 4, unsubscribe: 3, bounce: 2, not_sent: 1.5, auto: 1 };

// Returns { kind, from, subject, snippet } for the strongest incoming
// message in the thread, or { kind: null } if nothing came back.
async function inspectThread(threadId, ownEmail) {
  const messages = await getThreadMessages(threadId);
  let best = { kind: null };
  for (const m of messages) {
    if ((m.labelIds || []).includes('DRAFT')) continue;
    if (header(m, 'From').toLowerCase().includes(ownEmail.toLowerCase())) continue;
    const kind = classify(m);
    if (!best.kind || RANK[kind] > RANK[best.kind]) {
      best = { kind, date: Number(m.internalDate || 0), from: header(m, 'From').slice(0, 200), subject: header(m, 'Subject').slice(0, 300), snippet: (m.snippet || '').slice(0, 500) };
    }
  }
  return best;
}

async function noteInNotion(lead, text) {
  if (!NOTION_TOKEN || !lead.notion_page_id) return;
  try {
    const getRes = await fetch(`https://api.notion.com/v1/pages/${lead.notion_page_id}`, {
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
    });
    const page = await getRes.json();
    const currentNotes = page.properties?.['Raw Notes']?.rich_text?.[0]?.plain_text || '';
    await fetch(`https://api.notion.com/v1/pages/${lead.notion_page_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { 'Raw Notes': { rich_text: [{ text: { content: `${currentNotes}\n\n${text}`.slice(0, 2000) } }] } } }),
    });
  } catch (err) {
    console.error(`check-replies: Notion note failed for ${lead.business_name}: ${err.message}`);
  }
}

// A starting point for the answer, picked by what they asked. No prices by
// email: the goal is a call.
function suggestedReply(lead, snippet) {
  const first = (lead.reply_from || '').replace(/<.*>/, '').trim().split(/\s+/)[0] || '';
  const hi = /^[A-Z][a-z]+$/.test(first) ? `Hi ${first},` : 'Hi,';
  if (/how much|price|pricing|cost|charge|rate|quote|budget/i.test(snippet)) {
    return `${hi}\n\nThanks for getting back to me! It depends on what you need, and we keep it affordable for small businesses. Could we do a quick 10-minute call so I can give you an exact number? What time works today or tomorrow?\n\nDeven`;
  }
  if (/call|phone|talk|speak|reach me|number/i.test(snippet)) {
    return `${hi}\n\nGreat, thanks! I'll give you a call. Is there a time today or tomorrow that's best?\n\nDeven`;
  }
  return `${hi}\n\nThanks for writing back! Happy to answer anything. Would a quick 10-minute call be easiest? Let me know a time that works and the best number to reach you.\n\nDeven`;
}

async function sendReplyAlert(lead, found, config) {
  const to = config.alert_email || config.reply_to_email;
  if (!to) return;
  const text = [
    `${lead.business_name} replied. Answering within the hour wins most deals.`,
    '',
    `From: ${found.from}`,
    `Subject: ${found.subject}`,
    `They said: "${found.snippet}"`,
    '',
    lead.phone ? `Call them: ${lead.phone}` : 'No phone number on file.',
    `Open the conversation: https://mail.google.com/mail/u/0/#all/${lead.gmail_thread_id}`,
    '',
    'Suggested answer (edit, then reply in that conversation):',
    '----',
    suggestedReply({ ...lead, reply_from: found.from }, `${found.subject} ${found.snippet}`),
  ].join('\n');
  await sendGmail({ to, subject: `Reply from ${lead.business_name}: answer now`, text });
}

const OUTCOME = {
  reply: { status: 'replied', note: '✅ REPLIED — sequence paused. Read it in Gmail.' },
  unsubscribe: { status: 'unsubscribed', note: '⛔ Asked not to be contacted — never email again.' },
  bounce: { status: 'bounced', note: '↩️ Email bounced — address is dead. Moved to the call list.' },
};

async function run() {
  const { data: active, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['new', 'contacted', 'cold'])
    .not('gmail_thread_id', 'is', null);
  if (error) throw error;

  // One-time self-repair: leads the OLD logic marked 'replied' (which
  // counted bounces as replies) get re-checked with the new rules.
  const { data: legacy, error: legacyErr } = await supabase
    .from('leads')
    .select('*')
    .eq('status', 'replied')
    .is('reply_kind', null)
    .not('gmail_thread_id', 'is', null);
  if (legacyErr) throw legacyErr;

  // Replies found before we started saving who sent them: re-read once so
  // the digest can show the actual message.
  const { data: noDetails, error: ndErr } = await supabase
    .from('leads')
    .select('*')
    .eq('reply_kind', 'reply')
    .is('reply_from', null)
    .not('gmail_thread_id', 'is', null);
  if (ndErr) throw ndErr;

  const leads = [...(active || []), ...(legacy || []), ...(noDetails || [])];
  if (leads.length === 0) {
    console.log('check-replies: no leads with an active thread yet.');
    return;
  }

  const ownEmail = await getOwnEmailAddress();
  const config = await loadSetting(supabase, 'outreach').catch(() => ({}));
  const tally = { reply: 0, unsubscribe: 0, bounce: 0, auto: 0, restored: 0, not_sent: 0 };

  for (const lead of leads) {
    // Pace thread reads so a big batch stays under Gmail's per-minute limit.
    await new Promise((r) => setTimeout(r, 400));
    try {
      const found = await inspectThread(lead.gmail_thread_id, ownEmail);
      const kind = found.kind;
      const isLegacy = lead.status === 'replied';

      if (kind === 'not_sent') {
        // Only for a limit notice newer than our last send, and only once.
        const sentAt = lead.last_contacted ? Date.parse(lead.last_contacted) : 0;
        if (lead.reply_kind !== 'not_sent' && found.date >= sentAt - 60000) {
          const step = Math.max((lead.sequence_step || 0) - 1, 0);
          const { error: rbErr } = await supabase.from('leads').update({
            sequence_step: step,
            status: step === 0 ? 'new' : 'contacted',
            reply_kind: 'not_sent',
            updated_at: new Date().toISOString(), // the sequencer skips sending for 24 h after this
            ...(step === 0 ? { gmail_thread_id: null } : {}),
          }).eq('id', lead.id);
          if (rbErr) throw new Error(rbErr.message);
          tally.not_sent++;
          console.log(`check-replies: ${lead.business_name} → not sent (Gmail limit), back to step ${step}`);
        }
        continue;
      }

      if (!kind || kind === 'auto') {
        if (kind) tally.auto++;
        if (isLegacy) {
          // Marked "replied" before, but nothing real is in the thread —
          // put it back in the sequence where it left off.
          const { error: restoreErr } = await supabase.from('leads').update({ status: 'contacted', reply_kind: kind || 'none' }).eq('id', lead.id);
          if (restoreErr) throw new Error(restoreErr.message);
          tally.restored++;
        }
        continue;
      }

      const outcome = OUTCOME[kind];
      const details = { reply_from: found.from || null, reply_subject: found.subject || null, reply_snippet: found.snippet || null };
      if (lead.status === outcome.status && lead.reply_kind === kind) {
        if (!lead.reply_from && details.reply_from) await supabase.from('leads').update(details).eq('id', lead.id);
        continue;
      }

      const { error: upErr } = await supabase.from('leads').update({
        status: outcome.status,
        reply_kind: kind,
        replied_at: new Date().toISOString(),
        gmail_draft_id: null,
        sequence_step: Math.max(lead.sequence_step, 1),
        last_contacted: lead.last_contacted || new Date().toISOString(),
        ...details,
      }).eq('id', lead.id);
      if (upErr) throw new Error(upErr.message);

      await noteInNotion(lead, `${outcome.note} (${new Date().toISOString().slice(0, 10)})`);
      if (kind === 'reply' && lead.reply_kind !== 'reply') {
        await sendReplyAlert(lead, found, config).catch((err) => console.error(`check-replies: alert failed for ${lead.business_name}: ${err.message}`));
      }
      tally[kind]++;
      console.log(`check-replies: ${lead.business_name} → ${kind}`);
    } catch (err) {
      console.error(`check-replies: failed checking ${lead.business_name}: ${err.message}`);
      runLog.error(`${lead.business_name} (${lead.id})`, err);
    }
  }

  const summary =
    `checked ${leads.length} threads. Real replies: ${tally.reply}. Unsubscribes: ${tally.unsubscribe}. ` +
      `Bounces: ${tally.bounce}. Not sent (Gmail limit, will resend): ${tally.not_sent}. Auto-replies ignored: ${tally.auto}. Old "replied" leads put back in sequence: ${tally.restored}.`;
  console.log(`check-replies: ${summary}`);
  await runLog.finish(summary);
}

run().catch(async (err) => {
  console.error('check-replies failed:', err);
  runLog.error('run', err);
  await runLog.finish('run failed');
  process.exit(1);
});
