# Enterprise Leads

Sources local business leads (missing/broken websites = website-studio
outreach targets) via Google Places, writes them into Notion's **Raw
Leads Inbox**, sends outreach from your **real Gmail account**, and
detects replies to pause a lead's sequence automatically. Runs
weekday mornings only.

Deliberately separate from the "opportunity-automation" repo (The
Board) — this is Sovereign/Enterprise business data, that's your
personal opportunity feed. Different repo, different code. The one
shared thing is the Supabase *project* (not tables).

## What runs, and when

1. **`check-replies.yml`** — 9:45am ET, Mon–Fri. Checks every actively
   sequenced lead's Gmail thread for a reply. If found: sets that
   lead's status to `replied` (sequence stops automatically) and
   appends a note in Notion's Raw Notes.
2. **`ingest-leads.yml`** — 8am ET, Mon–Fri. Searches every
   location × category combination in your settings, checks each
   business's site for missing SSL / no mobile viewport / no site at
   all, AND checks for social media links on the site. Classifies
   each hot lead as needing `website`, `social`, or `both`, and
   writes it to Notion + mirrors to Supabase with that classification.
3. **`send-leads-digest.yml`** — 8:30am ET, Mon–Fri. Emails you
   everything captured that morning.
4. **`send-outreach.yml`** — 10am ET, Mon–Fri, *after* the reply check.
   Sends the next due touch — **tailored to what that lead actually
   needs**: a website-focused pitch (with before-screenshot) for
   broken/missing sites, a social-focused pitch (no screenshot) for
   fine sites with no social presence, or both. Sent via your real
   Gmail account, threaded, synced to Notion.

**Full loop, as built:** find leads across every location/category →
classify what each one needs → email from you with a tailored pitch →
reply pauses the sequence automatically → non-replies get 6 weekly
follow-ups → everything visible in Notion throughout.

**Email gap, still real:** Google Places doesn't return business
emails. The ingest script scans each site's homepage for a `mailto:`
link — catches maybe half. Leads with no email sit with `email: null`
and are skipped by the sequencer. Check Notion's Raw Notes and fill
one in by hand if you find it.

## Settings — edit via a real interface, not JSON files

`dashboard/settings.html` — form fields for:
- **Locations and categories, independently.** Add a location and
  every existing business category gets searched there automatically.
  Add a category and it's searched in every existing location. No
  need to write out every combination by hand.
- Max leads/day, outreach cadence, sender identity, digest behavior.

Saves write straight to Supabase; next scheduled run picks them up.
See "Setup" below for how to open it correctly (edit as a text file
first, not just double-clicked).

**Tailored messaging, how it works:** the first email a lead gets is
one of three variants (`settings.outreach.touch_sets.website /
.social / .both`) depending on what the ingest script detected they
need. The 5 follow-ups after that are shared copy
(`settings.outreach.followups`) with an `{offer_phrase}` placeholder
that still says the right thing ("your website" vs. "your social
media presence" vs. "your website and social media") without needing
15 separately hand-written follow-up emails. None of this email copy
is in the settings form — describe what you want changed in chat and
I'll update it directly in Supabase.

## Where things live

- **Notion Raw Leads Inbox** — human review/triage, plus live
  `Outreach Step` / `Last Outreach` / reply notes.
- **Supabase `leads` table** — machine-tracked state: status,
  sequence_step, email, `notion_page_id`, `gmail_thread_id`,
  `has_social`, `need_type`.
- **Supabase `settings` table** — the config knobs.
- **Your Gmail account** — actual sending + reply detection, via a
  one-time OAuth setup (see below).

## Setup

### 1. Notion integration
Already done — confirm it has access to Raw Leads Inbox (Notion page
→ "..." → Connections).

### 2. Gmail OAuth (one-time)
1. [console.cloud.google.com](https://console.cloud.google.com) →
   enable the Gmail API on your project.
2. "OAuth consent screen" → External → fill in app name + your email
   → add yourself as a test user (fine to stay in "Testing" mode
   forever for personal use).
3. "Credentials" → "+ Create Credentials" → "OAuth client ID" → type
   "Web application" → Authorized redirect URI:
   `https://developers.google.com/oauthplayground` → Create. Save the
   Client ID and Client Secret shown.
4. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
   → gear icon → "Use your own OAuth credentials" → paste Client
   ID/Secret.
5. Search "Gmail API v1" in the left panel, check `gmail.send` and
   `gmail.readonly` → "Authorize APIs" → sign in with the Gmail
   account you want to send from → Allow.
6. "Exchange authorization code for tokens" → copy the **Refresh
   Token** shown. This is the long-lived credential — save it.

### 3. Run the schema
In Supabase SQL Editor (`opportunity-automation` project), run the
entirety of `supabase/settings-schema.sql` — adds `gmail_thread_id` to
`leads`, creates the `settings` table, seeds defaults.

### 4. Secrets (repo Settings → Secrets and variables → Actions)
- `GOOGLE_PLACES_API_KEY`
- `NOTION_TOKEN`, `NOTION_DATABASE_ID` = `d69c0026-0993-486c-afdc-d0de72c9ded0`
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` —
  from step 2

### 5. Fill in and open the settings page
Right-click `dashboard/settings.html` → open with a **text editor**
(not double-click, that opens it as a webpage first). Find and
replace:
```
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```
with your real values (Project Settings → API — the **anon/public**
key, never service_role). Save the file, *then* double-click it to
open in a browser. Fill in your real name, reply-to email, and
test-mode recipient — the seeded defaults are placeholders that block
sends until changed.

### 6. Push and test
Push this folder as a new private repo. Test in order: "Ingest leads
to Notion", "Send leads digest email", then with `test_mode: true`
(set via the settings page) run "Send outreach touches" a couple
times to check real Gmail formatting/screenshots land correctly in
your own inbox. Only flip `test_mode` off once that looks right —
that's the one switch that makes it real. "Check for lead replies"
can run anytime; it's read-only until it finds an actual reply.
