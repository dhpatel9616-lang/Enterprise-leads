-- Outreach v8 (owner, 2026-11-04): stop mass email. First emails go ONLY to
-- dental/medical offices (category medical) whose website has a real problem,
-- checked live before each send, 5 a day (25 over a week), with a short
-- personal note instead of the menu pitch. People already emailed still get
-- their remaining follow-ups. Podcast guests are unaffected.
-- Undo: set first_email_categories to null and max_new_sends_per_run back to 25.

update settings set value = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(value,
    '{touch_sets,medical}', $j$[{"step": 1, "delay_days": 0, "subject": "{business_name}'s website on a phone", "body": "Hi,\n\nI was looking up {business_name} on my phone and noticed your website {issue_line}. For a practice, that's usually the moment a new patient gives up and calls the next office on Google.{sample_line}\n\nI'm Deven, and I run a small studio, Wade Capital, that fixes exactly this for local practices at a fixed price. If it helps, we can also set up an after-hours phone assistant that books new patients while the front desk is closed.\n\n{booking_line}\n\n{sender_name}"}]$j$::jsonb, true),
    '{followup_sets,medical}', $j$[{"step": 2, "delay_days": 4, "subject": "{business_name}'s website on a phone", "body": "Hi, a quick follow-up. If a call is too much right now, just reply \"send it\" and I'll email you the three fixes I'd make first on {business_name}'s site, free, no call needed.\n\n{sender_name}"}, {"step": 3, "delay_days": 10, "subject": "{business_name}'s website on a phone", "body": "Hi, I'll close the file after this one. If the website or after-hours calls become a priority for {business_name}, reply \"yes\" and I'll send a few times.\n\n{sender_name}"}]$j$::jsonb, true),
    '{problem_required_categories}', '["medical"]'::jsonb, true),
    '{first_email_categories}', '["medical"]'::jsonb, true),
    '{max_new_sends_per_run}', '5'::jsonb, true)
where key = 'outreach';
