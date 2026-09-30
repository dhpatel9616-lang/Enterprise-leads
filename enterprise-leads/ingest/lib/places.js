// Google Places text search with the shared monthly free-tier guard.
//
// Every search that asks for website/phone is billed in Google's "Text
// Search Enterprise" tier: 1,000 free per month, then about $35 per
// 1,000. All scripts count searches in the `places_usage` settings row
// and stop at `monthly_search_cap` (settings.places_queries, default 950),
// so the pipeline never produces a Google bill.

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.businessStatus',
].join(',');

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function createPlacesClient(supabase, apiKey) {
  let usage = null;
  let cap = 950;

  async function init() {
    const { data: q } = await supabase.from('settings').select('value').eq('key', 'places_queries').maybeSingle();
    cap = q?.value?.monthly_search_cap ?? 950;
    const { data } = await supabase.from('settings').select('value').eq('key', 'places_usage').maybeSingle();
    const value = data?.value || {};
    usage = value.month === monthKey() ? value : { month: monthKey(), searches: 0 };
  }

  async function save() {
    const { error } = await supabase
      .from('settings')
      .upsert({ key: 'places_usage', value: usage, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) console.error(`places: couldn't save search usage: ${error.message}`);
  }

  // Returns an array of places, or null when the monthly cap is reached.
  async function searchText(textQuery, { pageSize = 5, locationBias } = {}) {
    if (!usage) await init();
    if (usage.searches >= cap) return null;
    const body = { textQuery, pageSize };
    if (locationBias) body.locationBias = { circle: { center: { latitude: locationBias.lat, longitude: locationBias.lng }, radius: locationBias.radius_meters } };
    let data;
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body),
      });
      data = await res.json();
      if (!res.ok) throw new Error(`Places search failed: ${JSON.stringify(data).slice(0, 300)}`);
    } finally {
      usage.searches++;
      await save();
    }
    return (data.places || []).filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL');
  }

  return { searchText, usage: () => usage, cap: () => cap };
}

module.exports = { createPlacesClient };
