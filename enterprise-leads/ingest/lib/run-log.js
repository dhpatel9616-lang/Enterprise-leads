// Records each run's summary and per-lead errors in the `pipeline_runs`
// table, so problems are visible from the database (and to Claude)
// without opening GitHub Actions logs. Never throws.
function createRunLog(supabase, script) {
  const errors = [];
  return {
    error(context, err) {
      errors.push({ context: String(context).slice(0, 200), message: String(err?.message || err).slice(0, 500) });
    },
    async finish(summary) {
      try {
        await supabase.from('pipeline_runs').insert({ script, summary: String(summary).slice(0, 2000), errors: errors.slice(0, 100) });
      } catch {
        // logging must never break the run
      }
    },
  };
}

module.exports = { createRunLog };
