/**
 * One-off demo of the AI phone agent for outreach emails: Bland calls the
 * phone number you give it, the agent answers as a pizza shop, and you play
 * a customer ordering a pizza. The recording is saved to the public
 * studio-videos bucket and its link to settings.outreach.demo_call_url, so
 * the restaurant email can say "hear it take an order".
 *
 * Only call a number you own: the person answering consents to the call
 * and the recording. The agent says it's an AI in its first sentence.
 *
 *   DEMO_PHONE=7035551234 node ingest/demo-call.js
 *
 * Requires BLAND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');

const { BLAND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, DEMO_PHONE } = process.env;
const digits = String(DEMO_PHONE || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
if (!BLAND_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || digits.length !== 10) {
  console.log('demo-call: needs BLAND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY and a 10-digit DEMO_PHONE.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TASK = `You are the phone assistant for Tony's Pizza, a small family pizza shop (a made-up shop for a demo).
Menu: cheese pizza (small $11, large $16), pepperoni (small $13, large $18), veggie (small $13, large $18), garlic knots $6, wings (10 for $12), 2-liter soda $3. Toppings $2 each.
Hours: 11am to 10pm every day. Pickup is ready in 20 minutes; delivery takes 40 minutes within 3 miles.
Take the caller's order: items, size, toppings, pickup or delivery (get the address for delivery), their name and a callback number. Read the order back with the total, then confirm the ready time.
Be warm, quick and natural. Answer questions about hours and the menu. If asked, confirm you are an AI assistant. Never invent menu items or prices that aren't listed.`;

async function bland(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.bland.ai/v1${path}`, {
    method,
    headers: { authorization: BLAND_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') throw new Error(`Bland ${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function run() {
  const { call_id } = await bland('/calls', {
    method: 'POST',
    body: {
      phone_number: `+1${digits}`,
      task: TASK,
      first_sentence: "Thanks for calling Tony's Pizza! I'm the shop's AI assistant, and this call may be recorded. What can I get started for you?",
      record: true,
      max_duration: 5,
      metadata: { source: 'enterprise-leads-demo' },
    },
  });
  console.log(`demo-call: calling now (call ${call_id}). Answer and order like a customer.`);

  let call;
  for (let i = 0; i < 60; i++) { // up to 10 minutes
    await new Promise((r) => setTimeout(r, 10000));
    call = await bland(`/calls/${call_id}`);
    if (call.completed || ['completed', 'failed', 'no-answer', 'busy'].includes(call.status)) break;
  }
  if (!call?.recording_url) {
    console.log(`demo-call: no recording (status ${call?.status}). Nothing saved; run it again.`);
    process.exit(1);
  }

  // Keep our own copy: a stable public link that doesn't depend on Bland.
  let url = call.recording_url;
  const audio = await fetch(call.recording_url);
  if (audio.ok) {
    const path = `demos/pizza-phone-agent-${new Date().toISOString().slice(0, 10)}.mp3`;
    const { error } = await supabase.storage.from('studio-videos')
      .upload(path, Buffer.from(await audio.arrayBuffer()), { contentType: 'audio/mpeg', upsert: true });
    if (!error) url = supabase.storage.from('studio-videos').getPublicUrl(path).data.publicUrl;
    else console.log(`demo-call: storage upload failed (${error.message}); using Bland's link.`);
  }

  const outreach = await loadSetting(supabase, 'outreach');
  const { error } = await supabase.from('settings').update({ value: { ...outreach, demo_call_url: url } }).eq('key', 'outreach');
  if (error) throw new Error(error.message);
  console.log(`demo-call: saved. Listen here: ${url}`);
}

run().catch((err) => {
  console.error('demo-call failed:', err.message);
  process.exit(1);
});
