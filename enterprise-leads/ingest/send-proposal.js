/**
 * Sends a client their proposal: a reply in the same Gmail conversation with
 * a link to their proposal page (wadecapital.netlify.app/proposal.html) and
 * the onboarding form. Run by hand from GitHub Actions → "Send Proposal".
 *
 * The proposal's details travel inside the link (base64 JSON), so nothing is
 * stored on the website. Scope text per service lives in proposal.html.
 *
 * Inputs (env): TO_EMAIL, SERVICE, PRICE, and optional PAY_LINK (a Stripe
 * Payment Link), TIMELINE, NOTE, BUSINESS (only needed if the email isn't a lead).
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_* secrets.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');
const { sendGmail, getThreadMessages } = require('./lib/gmail');

const SITE = 'https://wadecapital.netlify.app';
const SERVICES = {
  website: 'a new website',
  'starter-menu': 'the restaurant starter menu',
  'ai-receptionist': 'an AI phone assistant',
  'google-listing': 'a Google listing cleanup',
  social: 'social media posting',
  'governance-audit': 'the AI Governance Readiness Audit',
  'automation-audit': 'the Automation Readiness Audit',
};

function proposalUrl(p) {
  return `${SITE}/proposal.html?d=${encodeURIComponent(Buffer.from(JSON.stringify(p)).toString('base64'))}`;
}

async function run() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, TO_EMAIL, SERVICE, PRICE, PAY_LINK, TIMELINE, NOTE, BUSINESS } = process.env;
  const to = (TO_EMAIL || '').trim().toLowerCase();
  if (!to || !SERVICES[SERVICE] || !PRICE) throw new Error('Need TO_EMAIL, a SERVICE from the list, and PRICE.');
  if (PAY_LINK && !/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(PAY_LINK.trim())) {
    throw new Error('PAY_LINK must be a Stripe payment link (https://buy.stripe.com/...).');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: lead } = await supabase.from('leads').select('*').ilike('email', to).limit(1).maybeSingle();
  const business = lead?.business_name || (BUSINESS || '').trim();
  if (!business) throw new Error(`No lead found with ${to}; fill in the business name.`);
  const config = await loadSetting(supabase, 'outreach');
  const mailingAddress = await loadSetting(supabase, 'business_mailing_address').catch(() => null);

  // Reply inside their existing conversation when there is one.
  let threadId, subject = `Your proposal from Wade Capital: ${business}`;
  if (lead?.gmail_thread_id) {
    const first = (await getThreadMessages(lead.gmail_thread_id))[0];
    const s = first?.payload?.headers?.find((h) => h.name.toLowerCase() === 'subject')?.value;
    if (s) { threadId = lead.gmail_thread_id; subject = s.startsWith('Re:') ? s : `Re: ${s}`; }
  }

  const first = (lead?.reply_from || '').replace(/<.*>/, '').trim().split(/\s+/)[0];
  const name = /^[A-Z][a-z]+$/.test(first) ? first : '';
  const url = proposalUrl({ b: business, c: name, s: SERVICE, price: PRICE.trim(), pay: PAY_LINK?.trim() || undefined, t: TIMELINE?.trim() || undefined, note: NOTE?.trim() || undefined });
  const text = `${name ? `Hi ${name},` : 'Hi,'}

Thanks again for your time. Here's the proposal for ${SERVICES[SERVICE]} for ${business}, with exactly what we'll do, the price and how to start:

${url}

Once you're ready, the onboarding form (about 10 minutes) is here: ${SITE}/onboard.html?b=${encodeURIComponent(business)}

Any questions, just reply here or call me.

${(config.sender_name || '').trim()}

--
${mailingAddress ? `Wade Capital LLC, ${String(mailingAddress).trim()}\n` : ''}If you'd rather not hear from me, just reply "unsubscribe" and I won't email again.`;

  await sendGmail({ to, subject, text, threadId, replyTo: config.reply_to_email || undefined, fromName: config.from_display_name || undefined, fromEmail: config.from_display_name ? config.reply_to_email : undefined });
  if (lead) {
    await supabase.from('leads').update({ callback_note: `Proposal sent ${new Date().toISOString().slice(0, 10)}: ${SERVICE}, ${PRICE.trim()}`, updated_at: new Date().toISOString() }).eq('id', lead.id);
  }
  console.log(`send-proposal: sent to ${business}. Proposal link: ${url}`);
}

run().catch((err) => {
  console.error('send-proposal failed:', err.message);
  process.exit(1);
});
