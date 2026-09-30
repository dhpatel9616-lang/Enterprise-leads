/**
 * AI phone channel (Bland AI). Two jobs each run:
 *
 *   1. COLLECT RESULTS for calls placed earlier: pull the transcript and
 *      summary from Bland, ask Bland's analyzer a few fixed questions, and
 *      record the outcome on the lead:
 *        do_not_call    → do_not_call = true, never called again
 *        send_info      → the email they gave is saved; the outreach
 *                         sequencer sends the mockup email next morning
 *                         (touch_sets.after_call)
 *        interested / callback → shown at the top of the daily digest
 *        not_interested, voicemail, no_answer, failed
 *
 *   2. PLACE NEW CALLS, only when ALL of these hold:
 *        - settings.phone_calls.enabled is true
 *        - it's inside the call window (default Tue–Thu, 10am–4pm ET)
 *        - this month's Bland spend is under monthly_budget_usd
 *        - the number was screened by phone-screen.js as a BUSINESS
 *          LANDLINE or fixed VoIP. Never cell phones: under the FCC's 2024
 *          ruling, AI voices count as "artificial voice" calls, which need
 *          prior consent on cell phones. Unscreened numbers are never called.
 *        - the lead has no working email (no website, or it bounced), has
 *          not asked not to be called, and isn't a real-estate lead.
 *      No-website businesses go first. Each lead gets at most
 *      max_attempts calls, spaced retry_after_days apart.
 *
 * The agent says it's an AI and that the call may be recorded in its very
 * first sentence (Maryland and Pennsylvania require all-party consent to
 * record), keeps calls short, and ends the call on any "not interested"
 * or "don't call".
 *
 * Requires BLAND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY. No-ops
 * safely if missing. DRY_RUN=1 prints what would be called.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { looksValid } = require('./lib/email-quality');
const { createRunLog } = require('./lib/run-log');

const BLAND = 'https://api.bland.ai/v1';
const { BLAND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || (!BLAND_API_KEY && !DRY_RUN)) {
  console.log('bland-calls: BLAND_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const runLog = createRunLog(supabase, DRY_RUN ? 'bland-calls-dry-run' : 'bland-calls');

const AI_SAFE_TYPES = ['landline', 'fixedVoip'];

const DEFAULTS = {
  enabled: false,
  max_calls_per_run: 10,
  monthly_budget_usd: 20,
  est_cost_per_call_usd: 0.08, // budget planning only; real per-call prices from Bland replace it
  max_attempts: 2,
  retry_after_days: 3,
  max_duration_min: 2,
  call_after_email_step: 2, // also call leads emailed this many times with no reply
  call_days: [1, 2, 3, 4, 5], // Mon–Fri (0 = Sunday)
  start_hour: 10,
  end_hour: 16,
  timezone: 'America/New_York',
  voice: null,
  agent_name: 'Alex',
  callback_number: '(703) 424-4201',
  transfer_phone_number: null, // e.g. "+17034244201" to hand interested owners straight to Deven
};

async function bland(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BLAND}${path}`, {
    method,
    headers: { authorization: BLAND_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') throw new Error(`Bland ${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function localParts(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date());
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday').value);
  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  return { day, hour };
}

function cityOf(lead) {
  if (lead.location_name) return lead.location_name.replace(/,\s*[A-Z]{2}$/, '');
  const m = /,\s*([^,]+),\s*[A-Z]{2}\s*\d{5}/.exec(lead.address || '');
  return m ? m[1] : 'your area';
}

function buildTask(cfg) {
  return `You are ${cfg.agent_name}, an AI assistant making a short call on behalf of Deven Patel, founder of Wade Capital, a small studio that builds websites for local businesses.

You are calling {{business_name}} in {{city}}. {{situation}} Deven already made a free sample website for them from their public Google listing, and wants to send them the link. There is no cost and no obligation.

Your goal, in order of preference:
1. Get the best email address to send the free sample site to. Ask them to spell it, then read it back letter by letter to confirm.
2. If they'd rather talk to a person, ask for their name and the best day and time for Deven to call back.

Rules you must follow:
- You already said you are an AI assistant and that the call may be recorded. If asked, always confirm you are an AI calling for Deven. Never claim to be human.
- Keep the call under two minutes. Be warm, brief, and plain-spoken. Never pressure or argue.
- If you reach a receptionist or employee, ask who handles the business's website or marketing and whether you can get an email for that person, or leave Deven's number: ${cfg.callback_number}.
- If they say they're not interested or already have a website they're happy with, thank them and end the call politely.
- If they ask not to be called again, apologize, say you'll make sure they aren't called again, and end the call immediately.
- If asked about price: websites are a fixed price that Deven quotes after seeing what they need, and hosting and updates can be included. Do not make up numbers.
- If asked how you got their number: it's the number on their public Google listing.
- Do not discuss anything unrelated to the sample website, and do not collect any payment or sensitive information.`;
}

const ANALYSIS_QUESTIONS = [
  ['Did the person ask not to be called again, or ask to be removed from calls?', 'boolean'],
  ['Did the person say they are interested, want to see the sample website, or want to talk to Deven?', 'boolean'],
  ['What email address did the person give? Return it exactly, lowercase, with no spaces, or null if none.', 'string'],
  ['Did the person ask for a callback? If yes, who should Deven ask for and when? Otherwise null.', 'string'],
  ['Did the person say they are not interested or already have a website they are happy with?', 'boolean'],
  ['Did a real person answer the call (not voicemail, not an automated phone menu only)?', 'boolean'],
];

const asBool = (v) => v === true || /^(true|yes)$/i.test(String(v || '').trim());
const asText = (v) => (v == null || /^(null|none|n\/a|no)$/i.test(String(v).trim()) ? null : String(v).trim());

// ---------- 1. collect results ----------
async function collectResults(counts) {
  const { data: pending, error } = await supabase
    .from('leads')
    .select('id, business_name, email, status, call_id, call_attempts')
    .in('call_status', ['queued', 'in_progress'])
    .not('call_id', 'is', null)
    .limit(200);
  if (error) throw new Error(error.message);

  for (const lead of pending || []) {
    try {
      const call = await bland(`/calls/${lead.call_id}`);
      if (!call.completed && !['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(call.status)) continue;

      const update = {
        call_status: call.status || 'completed',
        call_cost: typeof call.price === 'number' ? call.price : null,
        call_summary: (call.summary || '').slice(0, 2000) || null,
      };
      const humanTalked = call.answered_by === 'human' || (call.call_length || 0) > 0.4;

      if (call.answered_by === 'voicemail') update.call_outcome = 'voicemail';
      else if (['no-answer', 'busy'].includes(call.status) || call.answered_by === 'no-answer') update.call_outcome = 'no_answer';
      else if (call.status === 'failed' || call.error_message) update.call_outcome = 'failed';

      if (!update.call_outcome && humanTalked) {
        const analysis = await bland(`/calls/${lead.call_id}/analyze`, {
          method: 'POST',
          body: { goal: 'Get an email address to send a free sample website to, or book a callback with Deven.', questions: ANALYSIS_QUESTIONS },
        });
        const [dnc, interested, emailRaw, callback, notInterested, realPerson] = analysis.answers || [];
        const email = looksValid(asText(emailRaw));
        if (asBool(dnc)) {
          update.call_outcome = 'do_not_call';
          update.do_not_call = true;
        } else if (email) {
          update.call_outcome = 'send_info';
          if (!lead.email || ['bounced', 'bad_email'].includes(lead.status)) {
            // Hand off to the email sequence: first email = after_call mockup email.
            Object.assign(update, { email, status: 'new', sequence_step: 0, gmail_thread_id: null, gmail_draft_id: null, email_enrichment_result: 'from_call' });
          }
        } else if (asText(callback)) {
          update.call_outcome = 'callback';
          update.callback_note = asText(callback).slice(0, 300);
        } else if (asBool(interested)) {
          update.call_outcome = 'interested';
        } else if (asBool(notInterested)) {
          update.call_outcome = 'not_interested';
        } else {
          update.call_outcome = asBool(realPerson) ? 'not_interested' : 'no_answer';
        }
      }
      if (!update.call_outcome) update.call_outcome = 'no_answer';
      // A clear "no" on the phone also stops the email sequence.
      if (['do_not_call', 'not_interested'].includes(update.call_outcome) && ['new', 'contacted', 'cold'].includes(lead.status)) {
        update.status = 'not_interested';
      }
      counts[update.call_outcome] = (counts[update.call_outcome] || 0) + 1;

      if (!DRY_RUN) {
        const { error: upErr } = await supabase.from('leads').update(update).eq('id', lead.id);
        if (upErr) throw new Error(upErr.message);
      }
      console.log(`  result: ${lead.business_name} → ${update.call_outcome}`);
    } catch (err) {
      counts.errors++;
      runLog.error(`result ${lead.business_name} (${lead.id})`, err);
      console.error(`bland-calls: couldn't read result for ${lead.business_name}: ${err.message}`);
    }
  }
}

// ---------- 2. place calls ----------
async function monthSpend(cfg) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { data } = await supabase.from('leads').select('call_cost, call_status').gte('called_at', start.toISOString()).not('call_id', 'is', null);
  let spent = 0;
  for (const r of data || []) spent += r.call_cost != null ? Number(r.call_cost) : cfg.est_cost_per_call_usd;
  return spent;
}

async function fetchCallQueue(cfg, limit) {
  const retryBefore = new Date(Date.now() - cfg.retry_after_days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, phone, phone_type, site_url, address, location_name, category, need_type, status, email, sequence_step, call_attempts, call_outcome, called_at')
    .in('phone_type', AI_SAFE_TYPES)
    .eq('do_not_call', false)
    .neq('product', 'real_estate')
    .in('need_type', ['website', 'both', 'social'])
    // No working email (no site, bounced), OR emailed at least twice with
    // no reply (the AI call is the follow-up that gets through).
    .or(`status.eq.bounced,status.eq.bad_email,status.eq.cold,and(status.eq.new,email.is.null),and(status.eq.contacted,sequence_step.gte.${cfg.call_after_email_step})`)
    .or(`call_outcome.is.null,and(call_outcome.in.(voicemail,no_answer,failed),called_at.lt.${retryBefore})`)
    .lt('call_attempts', cfg.max_attempts)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = data || [];
  // No-website businesses first, then never-emailed, then emailed-no-reply.
  const rank = (l) => (l.site_url ? 1 : 0) * 2 + (l.email ? 1 : 0);
  rows.sort((a, b) => rank(a) - rank(b));
  return rows.slice(0, limit);
}

async function placeCalls(cfg, counts) {
  if (!cfg.enabled) {
    console.log('bland-calls: calling is switched off (settings.phone_calls.enabled = false). Results were still collected.');
    return;
  }
  const { day, hour } = localParts(cfg.timezone);
  if (!cfg.call_days.includes(day) || hour < cfg.start_hour || hour >= cfg.end_hour) {
    console.log(`bland-calls: outside the call window (${cfg.timezone} day ${day}, hour ${hour}). No calls placed.`);
    return;
  }
  const spent = await monthSpend(cfg);
  const budgetLeft = cfg.monthly_budget_usd - spent;
  const affordable = Math.floor(budgetLeft / cfg.est_cost_per_call_usd);
  const limit = Math.min(cfg.max_calls_per_run, affordable);
  counts.spent = spent;
  if (limit <= 0) {
    console.log(`bland-calls: monthly budget reached ($${spent.toFixed(2)} of $${cfg.monthly_budget_usd}). No calls placed.`);
    return;
  }

  const queue = await fetchCallQueue(cfg, limit);
  const task = buildTask(cfg);
  for (const lead of queue) {
    const to = toE164(lead.phone);
    if (!to) continue;
    const situation = lead.email
      ? "Deven emailed them a sample website recently but hasn't heard back; mention that briefly and offer to resend it."
      : lead.site_url
      ? "Their website has some problems (for example it doesn't work well on phones)."
      : "They don't appear to have a website.";
    const body = {
      phone_number: to,
      task,
      first_sentence: `Hi, this is ${cfg.agent_name}, an AI assistant calling for Deven Patel at Wade Capital, and this call may be recorded. Am I speaking with ${lead.business_name}?`,
      wait_for_greeting: true,
      record: false,
      max_duration: cfg.max_duration_min,
      timezone: cfg.timezone,
      request_data: { business_name: lead.business_name, city: cityOf(lead), situation },
      metadata: { lead_id: lead.id, source: 'enterprise-leads' },
      // Voicemail time is billed like talk time, so hang up on voicemail
      // until the last attempt, then leave one short message.
      voicemail:
        (lead.call_attempts || 0) + 1 >= cfg.max_attempts
          ? { action: 'leave_message', message: `Hi, this is an AI assistant for Deven Patel at Wade Capital. Deven made a free sample website for ${lead.business_name}. To see it, call or text ${cfg.callback_number}. Thanks!` }
          : { action: 'hangup' },
    };
    if (cfg.voice) body.voice = cfg.voice;
    if (cfg.transfer_phone_number) body.transfer_phone_number = cfg.transfer_phone_number;

    if (DRY_RUN) {
      console.log(`  [dry run] would call ${lead.business_name} ${to} (${lead.site_url ? 'has site' : 'no website'}, attempt ${lead.call_attempts + 1})`);
      counts.placed++;
      continue;
    }
    try {
      const res = await bland('/calls', { method: 'POST', body });
      const { error: upErr } = await supabase
        .from('leads')
        .update({ call_id: res.call_id, call_status: 'queued', called_at: new Date().toISOString(), call_attempts: (lead.call_attempts || 0) + 1, call_outcome: null })
        .eq('id', lead.id);
      if (upErr) throw new Error(`saved call but couldn't update lead: ${upErr.message}`);
      counts.placed++;
      await new Promise((r) => setTimeout(r, 4000)); // don't stack calls on top of each other
    } catch (err) {
      counts.errors++;
      runLog.error(`call ${lead.business_name} (${lead.id})`, err);
      console.error(`bland-calls: call to ${lead.business_name} failed: ${err.message}`);
      if (/insufficient|balance|credit|limit/i.test(err.message)) break;
    }
  }
}

async function run() {
  const saved = await loadSetting(supabase, 'phone_calls').catch(() => ({}));
  const cfg = { ...DEFAULTS, ...saved };
  const counts = { placed: 0, errors: 0 };
  if (BLAND_API_KEY) await collectResults(counts);
  await placeCalls(cfg, counts);
  const outcomes = Object.entries(counts)
    .filter(([k]) => !['placed', 'errors', 'spent'].includes(k))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const summary = `calls placed: ${counts.placed}. results collected: ${outcomes || 'none'}. month spend so far: ${counts.spent != null ? `$${counts.spent.toFixed(2)}` : 'n/a'} of $${cfg.monthly_budget_usd}. errors: ${counts.errors}.`;
  console.log(`bland-calls${DRY_RUN ? ' [DRY RUN]' : ''}: ${summary}`);
  await runLog.finish(summary);
}

run().catch(async (err) => {
  console.error('bland-calls failed:', err);
  runLog.error('run', err);
  await runLog.finish('run failed');
  process.exit(1);
});
