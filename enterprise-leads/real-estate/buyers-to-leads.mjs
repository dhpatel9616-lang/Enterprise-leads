// real-estate/buyers-to-leads.mjs
//
// Turns the Baltimore cash-buyer list (re_buyers) into email outreach.
//
// For the most active buyers not yet looked up, it searches Google for
// the company, and when a listing clearly matches (name overlap + a
// website), it adds the company to the `leads` table as:
//   product 'real_estate', need_type 'buyer_intro'
// From there the existing pipeline takes over automatically:
//   enrich-emails finds an address on their site → outreach-sequencer
//   sends the investor intro (settings.outreach.touch_sets.buyer_intro,
//   follow-ups in followup_sets.buyer_intro) → check-replies catches
//   answers → replies show up in the daily digest.
//
// Uses the shared Google free-tier guard (lib/places.js). Runs after
// baltimore-pull.mjs in the weekly real-estate workflow.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_PLACES_API_KEY.
// Settings (optional): settings.real_estate.max_buyer_lookups_per_run (default 15).

import { createClient } from "@supabase/supabase-js";
import placesLib from "../ingest/lib/places.js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_PLACES_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GOOGLE_PLACES_API_KEY) {
  console.log("buyers-to-leads: SUPABASE_URL, SUPABASE_SERVICE_KEY or GOOGLE_PLACES_API_KEY missing. Skipping run.");
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const places = placesLib.createPlacesClient(supabase, GOOGLE_PLACES_API_KEY);
const BALTIMORE = { lat: 39.2904, lng: -76.6122, radius_meters: 40000 };

// Words that don't identify a company ("SMITH PROPERTIES LLC" → "SMITH").
const FILLER = new Set(
  "LLC L C INC CORP CORPORATION CO COMPANY LP LLP LTD THE OF AND TRUST TRUSTEE PROPERTIES PROPERTY HOLDINGS HOLDING INVESTMENTS INVESTMENT INVESTORS INVEST CAPITAL GROUP PARTNERS REALTY HOMES HOME HOUSING VENTURES VENTURE DEVELOPMENT MANAGEMENT ENTERPRISES ENTERPRISE ASSOCIATES FUND ESTATE ESTATES REAL SOLUTIONS RENTALS RENTAL ASSETS ASSET BALTIMORE MD MARYLAND I II III IV".split(" ")
);

const tokens = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FILLER.has(t));

// A Google result counts as the same company only if every distinctive
// word of the owner name appears in the listing's name (at least one).
function isMatch(ownerName, listingName) {
  const want = tokens(ownerName);
  if (want.length === 0) return false;
  const have = new Set(tokens(listingName));
  return want.every((t) => have.has(t));
}

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bLlc\b/, "LLC").trim();

async function main() {
  const { data: cfgRow } = await supabase.from("settings").select("value").eq("key", "real_estate").maybeSingle();
  const maxLookups = cfgRow?.value?.max_buyer_lookups_per_run ?? 15;

  const { data: buyers, error } = await supabase
    .from("re_buyers")
    .select("*")
    .eq("status", "new")
    .is("contact_lookup_at", null)
    .order("purchases_12mo", { ascending: false })
    .order("purchases_24mo", { ascending: false })
    .limit(maxLookups);
  if (error) throw new Error(error.message);

  const tally = { searched: 0, matched: 0, noWebsite: 0, noMatch: 0, capped: false };
  for (const b of buyers || []) {
    if (tokens(b.owner_name).length === 0) {
      await supabase.from("re_buyers").update({ contact_lookup_at: new Date().toISOString(), contact_lookup_result: "generic_name" }).eq("owner_key", b.owner_key);
      continue;
    }
    const results = await places.searchText(`${titleCase(b.owner_name)} Baltimore MD`, { locationBias: BALTIMORE });
    if (results === null) {
      tally.capped = true;
      break;
    }
    tally.searched++;
    const hit = results.find((p) => isMatch(b.owner_name, p.displayName?.text));
    let result = "no_match";
    let leadId = null;

    if (hit && !hit.websiteUri) {
      result = "match_no_website";
      tally.noWebsite++;
    } else if (hit) {
      const { data: existing } = await supabase.from("leads").select("id").eq("google_place_id", hit.id).limit(1).maybeSingle();
      if (existing) {
        leadId = existing.id;
        result = "already_a_lead";
      } else {
        const context = `I noticed ${hit.displayName.text} picked up ${b.purchases_12mo || b.purchases_24mo} properties in Baltimore City over the past ${b.purchases_12mo ? "year" : "two years"}. `;
        const { data: inserted, error: insErr } = await supabase
          .from("leads")
          .insert({
            business_name: hit.displayName.text,
            category: "real-estate-investor",
            phone: hit.nationalPhoneNumber || null,
            site_url: hit.websiteUri,
            address: hit.formattedAddress || null,
            location_name: "Baltimore, MD",
            google_place_id: hit.id,
            product: "real_estate",
            need_type: "buyer_intro",
            outreach_context: context,
            product_context: { re_buyer_key: b.owner_key, purchases_12mo: b.purchases_12mo, purchases_24mo: b.purchases_24mo, median_price: b.median_price },
            status: "new",
            sequence_step: 0,
          })
          .select("id")
          .single();
        if (insErr) throw new Error(`lead insert failed for ${b.owner_name}: ${insErr.message}`);
        leadId = inserted.id;
        result = "lead_created";
        tally.matched++;
      }
    } else {
      tally.noMatch++;
    }

    await supabase
      .from("re_buyers")
      .update({ contact_lookup_at: new Date().toISOString(), contact_lookup_result: result, lead_id: leadId, status: leadId ? "lead_created" : "new" })
      .eq("owner_key", b.owner_key);
  }

  const summary = `looked up ${tally.searched} buyers: ${tally.matched} added to email outreach, ${tally.noWebsite} found but no website, ${tally.noMatch} not found on Google${tally.capped ? " (stopped: monthly Google search cap reached)" : ""}. Google searches this month: ${places.usage()?.searches ?? "?"}/${places.cap()}.`;
  console.log(`buyers-to-leads: ${summary}`);
  await supabase.from("pipeline_runs").insert({ script: "re-buyers-to-leads", summary, errors: [] });
}

main().catch(async (err) => {
  console.error("buyers-to-leads failed:", err.message);
  await supabase.from("pipeline_runs").insert({ script: "re-buyers-to-leads", summary: "run failed", errors: [{ context: "run", message: String(err.message).slice(0, 500) }] });
  process.exit(1);
});
