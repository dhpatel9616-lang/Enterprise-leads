/**
 * Screens each lead's phone number via Twilio Lookup (Line Type
 * Intelligence) to classify it landline / mobile / VoIP / other,
 * BEFORE any automated voice channel is allowed to call it.
 *
 * This is the TCPA gate: under the 2024 FCC "artificial voice" ruling,
 * an AI-generated or pre-recorded voice call gets no lighter treatment
 * on a personal cell number than a live AI call would. Only numbers
 * Twilio classifies as landline (or fixed VoIP tied to a business
 * address) are eligible for the automated Bland AI channel. Everything
 * else — mobile, non-fixed VoIP, unknown — is routed to the personal
 * manual-dialer queue only, never to automated voice.
 *
 * Writes phone_type + phone_screened_at back onto the lead. Downstream
 * calling logic should filter on phone_type, never call a lead whose
 * phone_type is still null (unscreened), and treat 'invalid' as
 * un-callable by any channel (bad/incomplete number, not worth a
 * manual dial either).
 *
 * Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SUPABASE_URL,
 * SUPABASE_SERVICE_KEY. No-ops safely if any are missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSetting } = require('./lib/settings');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!TWILIO_SID || !TWILIO_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.log('phone-screen: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Twilio's own `type` values (from line_type_intelligence) that are
// safe to hand to the automated voice channel. Add types here only
// after confirming they don't carry personal-cell TCPA risk — when in
// doubt, leave a type OFF this list; it just falls through to the
// manual dialer, which is always safe regardless of phone type.
const LANDLINE_SAFE_TYPES = new Set(['landline', 'fixedVoip']);

// Normalizes a US-style number ("(814) 555-1234", "814-555-1234", a
// bare 10-digit string, etc.) to E.164 for Twilio Lookup. Returns null
// for anything that isn't a clean 10- or 11-digit US number — those
// are marked 'invalid' rather than guessed at.
function toE164(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function lookupLineType(e164) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio Lookup failed for ${e164}: ${JSON.stringify(data)}`);
  return data.line_type_intelligence?.type || 'unknown';
}

async function run() {
  const config = await loadSetting(supabase, 'phone_screening').catch(() => ({ max_per_run: 50 }));
  const maxPerRun = config.max_per_run ?? 50;

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, phone')
    .is('phone_type', null)
    .not('phone', 'is', null)
    .limit(maxPerRun);

  if (error) throw new Error(`Failed to load leads: ${error.message}`);

  let screened = 0;
  let landlineSafe = 0;
  let mobile = 0;
  let other = 0;
  let invalid = 0;

  for (const lead of leads) {
    const e164 = toE164(lead.phone);

    if (!e164) {
      invalid++;
      await supabase
        .from('leads')
        .update({ phone_type: 'invalid', phone_screened_at: new Date().toISOString() })
        .eq('id', lead.id);
      continue;
    }

    let type;
    try {
      type = await lookupLineType(e164);
    } catch (err) {
      // Leave phone_type null so this lead is retried next run rather
      // than permanently mislabeled by a transient API failure.
      console.error(`phone-screen: lookup failed for lead ${lead.id}:`, err.message);
      continue;
    }

    await supabase
      .from('leads')
      .update({ phone_type: type, phone_screened_at: new Date().toISOString() })
      .eq('id', lead.id);

    screened++;
    if (LANDLINE_SAFE_TYPES.has(type)) landlineSafe++;
    else if (type === 'mobile') mobile++;
    else other++;
  }

  console.log(
    `phone-screen: screened ${screened} (${landlineSafe} landline-safe → automated-voice eligible, ${mobile} mobile → manual-dialer only, ${other} other), ${invalid} invalid numbers skipped.`
  );
}

run().catch((err) => {
  console.error('phone-screen failed:', err);
  process.exit(1);
});
