# Enterprise Leads

Sources local business leads (missing/broken websites = website-studio
outreach targets) via Google Places, and writes them straight into
Notion's **Raw Leads Inbox** — no separate database, Notion *is* the
database for this pipeline. Runs weekday mornings only.

Deliberately separate from the "opportunity-automation" repo (The
Board) — this is Sovereign/Enterprise business data, that's your
personal opportunity feed. Different repo, different secrets, no
shared code.

## What runs, and when

1. **`ingest-leads.yml`** — 8am ET, Mon–Fri. Runs `notion-leads-ingest.js`:
   queries Google Places across every category in
   `config/places-queries.json`, checks each business's site for
   missing SSL / no mobile viewport / no site at all, and writes
   anything flagged into Raw Leads Inbox with `Review Status:
   Unreviewed`. Skips businesses already in Notion (matched by exact
   Company name) so re-running never duplicates. Also mirrors the
   same lead into a Supabase `leads` table (business_name, category,
   phone, email, site_url, has_ssl, mobile_ok, status,
   sequence_step) — Notion is your review/triage layer, Supabase is
   what the outreach sequencer below actually tracks against.
2. **`send-leads-digest.yml`** — 8:30am ET, Mon–Fri, 30 min after
   ingest. Runs `send-leads-digest.js`: emails you everything
   captured that morning.
3. **`send-outreach.yml`** — 10am ET, Mon–Fri. Runs
   `outreach-sequencer.js`: finds leads due for their next touch (day
   0 / 4 / 10, see `config/outreach.json`), generates a live
   screenshot of their current site, sends the email, and advances
   their `sequence_step`. After the 3rd touch, status flips to
   `cold` automatically.

**Email gap, by design, not oversight:** Google Places doesn't return
business emails. The ingest script scans each site's homepage HTML for
a `mailto:` link as a free, best-effort catch — it'll get maybe half.
Leads with no email found sit with `email: null` in Supabase and are
automatically skipped by the outreach sequencer (never guesses an
address). Check those manually in Notion's Raw Notes field
periodically and fill in an email by hand if you find one, or drop the
lead's status to `cold` if it's not worth chasing.

## Expanding the business categories

Edit `config/places-queries.json` — add a line, no code changes.
Already covers 20+ categories: restaurants, salons, contractors,
legal, financial, medical, retail, and more, all geofenced to State
College. Widen the radius or add a second city by editing
`location_bias` or adding a second query block with its own bias.

## Making the digest tweakable

`config/digest.json` controls the leads-captured email:
- `only_todays_captures`: `true` (default) shows only what came in
  that morning. Set `false` to show every still-Unreviewed lead
  regardless of age — useful if you fall behind on reviewing.
- Everything else (subject line, sender) is also just JSON — edit
  and commit, no code touched.

## Making the outreach sequence tweakable

`config/outreach.json` controls the cold-email cadence — all JSON,
no code:
- `touches`: the 3 emails themselves — subject, body (with
  `{business_name}`, `{sender_name}`, `{issue_line}` placeholders),
  and `delay_days` for spacing. Add a 4th touch, change the wording,
  or shift timing by editing this array.
- `max_sends_per_run`: caps volume per day (default 25, per the
  brief's 15-25/day guidance).
- Stopping a lead's sequence early (they replied, became a client, or
  you just want to drop them) is a one-field edit in Supabase: change
  that row's `status` to `replied`, `client`, or `cold`. The
  sequencer only ever touches rows still at `new` or `contacted`.

**Not automated yet:** reply detection. There's no inbox-monitoring
here — if a business replies, you need to manually flip their status
in Supabase (or Notion) to stop further touches. Automating that would
mean reading your inbox (Gmail connector), which is a deliberate next
step, not something wired in by default.

## Setup

### 1. Notion integration
Already done — reusing the token from your other Notion automation
work. Just confirm the integration has access to the Raw Leads Inbox
database (Notion page → "..." → Connections).

### 2. Secrets (repo Settings → Secrets and variables → Actions)
- `GOOGLE_PLACES_API_KEY` — same key from the Board setup, or a new
  restricted one.
- `NOTION_TOKEN` — your existing integration token.
- `NOTION_DATABASE_ID` — `d69c0026-0993-486c-afdc-d0de72c9ded0`
  (Raw Leads Inbox's ID — already resolved for you).
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — your `opportunity-automation`
  Supabase project's API URL and service_role key (same place you
  grabbed these for the Board setup).
- `RESEND_API_KEY` — same account as the Board's digest, or a
  separate one if you want leads and opportunities on different
  sending identities.

### 3. Edit two config files
- `config/digest.json` — replace `YOUR_EMAIL@example.com` with your
  real address.
- `config/outreach.json` — replace `YOUR_EMAIL@example.com` (reply-to)
  and `YOUR_NAME` (sender sign-off) with your real values.

### 4. Push and test
Push this folder as a new private repo. Test in this order: Actions →
"Ingest leads to Notion" → Run workflow (check Raw Leads Inbox *and*
Supabase's `leads` table for new rows), then "Send leads digest email",
then "Send outreach touches" last — that one actually emails real
businesses, so double-check `config/outreach.json` has real values
before running it for real.
