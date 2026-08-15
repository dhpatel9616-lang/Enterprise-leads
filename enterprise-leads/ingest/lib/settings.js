// Settings now live in Supabase's `settings` table (see
// supabase/settings-schema.sql), editable via dashboard/settings.html.
// This replaces reading config/*.json directly at runtime.
async function loadSetting(supabase, key) {
  const { data, error } = await supabase.from('settings').select('value').eq('key', key).single();
  if (error) throw new Error(`Failed to load setting "${key}": ${error.message}`);
  return data.value;
}

module.exports = { loadSetting };
