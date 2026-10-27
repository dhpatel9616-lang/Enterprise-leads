-- Outreach v7 (owner, 2026-10-21): invites for podcast guests the owner wants
-- on The Sovereign. Guests come from Notion → Podcast Guests via
-- ingest/podcast-guests.js (need_type podcast_guest); {context} is the
-- guest's personal line, written per guest. One invite and two short
-- follow-ups (days 7 and 14). Until this runs, guests get no email at all
-- (the sequencer never falls back to a business pitch for them).
-- Copy only; caps and switches are unchanged. Re-runnable.

update settings set value = jsonb_set(jsonb_set(value,
    '{touch_sets,podcast_guest}', $j$[{"step": 1, "delay_days": 0, "subject": "Podcast invite: {business_name} on The Sovereign", "body": "Hi {first_name},\n\n{context}\n\nI'm Deven Patel, and I write The Sovereign, a newsletter and podcast about philosophy, policy and the human condition, for a young audience that's new to these ideas. It's a young show, and I'd love for you to be one of its first conversations: 30 to 45 minutes, recorded remotely, whenever suits you.\n\nIf you're open to it, reply with a couple of times over the next few weeks and I'll handle the rest.\n\n{sender_name}"}]$j$::jsonb, true),
    '{followup_sets,podcast_guest}', $j$[{"step": 2, "delay_days": 7, "subject": "Podcast invite: {business_name} on The Sovereign", "body": "Hi {first_name}, floating this back up in case it got buried. Happy to work around your schedule, and glad to send topics ahead of time.\n\n{sender_name}"}, {"step": 3, "delay_days": 14, "subject": "Podcast invite: {business_name} on The Sovereign", "body": "Hi {first_name}, last note from me on this. If the timing is ever better, the invitation stands: just reply here.\n\n{sender_name}"}]$j$::jsonb, true)
where key = 'outreach';
