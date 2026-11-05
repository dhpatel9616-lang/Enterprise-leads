-- Outreach v9 (owner, 2026-11-05): teachers and professors who teach news or
-- media literacy, journalism or civics get one short note inviting them to use
-- The Global Aggregate in class, and one follow-up. They come from Notion → GA
-- Educators (Status Ready, with a public faculty-page email) via
-- ingest/podcast-guests.js (NEED_TYPE=educator). The opt-out line stays.
-- Until this runs, educators get no email (no copy, no send). Re-runnable.

update settings set value = jsonb_set(jsonb_set(value,
    '{touch_sets,educator}', $j$[{"step": 1, "delay_days": 0, "subject": "A free tool for teaching news literacy", "body": "Hi {first_name},\n\n{context}\n\nI built The Global Aggregate, a free site that puts how outlets in different countries headlined the same story side by side, with state-affiliated outlets labeled. It might make a quick class exercise: pick one story, compare five countries' headlines, and ask students what each one chose to leave out.\n\nhttps://www.globalaggregate.org (free, no sign-up)\n\nIf you try it, I'd love to hear what would make it more useful in a classroom.\n\n{sender_name}"}]$j$::jsonb, true),
    '{followup_sets,educator}', $j$[{"step": 2, "delay_days": 7, "subject": "A free tool for teaching news literacy", "body": "Hi {first_name}, floating this back up in case it got buried. If a ready-made one-page class exercise would help, reply \"send it\" and I'll email one.\n\n{sender_name}"}]$j$::jsonb, true)
where key = 'outreach';
