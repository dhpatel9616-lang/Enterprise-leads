-- Outreach v8 (owner, 2026-11-04): stop mass email. First emails go ONLY to
-- medical offices and law firms, 6 a day (about 30 a week), as short personal
-- notes offering AI governance (policy + safe tools + training) and website
-- design. Medical offices are emailed only when their website has a real
-- problem, checked live before each send. Law firms lead with AI governance
-- and mention the website only when a real problem was found.
-- People already emailed still get their remaining follow-ups.
-- Undo: set first_email_categories to null and max_new_sends_per_run back to 25.

update settings set value = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(value,
    '{touch_sets,medical}', $j$[{"step": 1, "delay_days": 0, "subject": "{business_name}'s website on a phone", "body": "Hi,\n\nI was looking up {business_name} on my phone and noticed your website {issue_line}. For a practice, that's usually the moment a new patient gives up and calls the next office on Google.{sample_line}\n\nI'm Deven, and I run a small studio, Wade Capital, that fixes exactly this for local practices at a fixed price. We also help practices put AI to work safely: a plain-English policy for how staff use tools like ChatGPT without putting patient information at risk, and the tools set up the right way.\n\n{booking_line}\n\n{sender_name}"}]$j$::jsonb, true),
    '{followup_sets,medical}', $j$[{"step": 2, "delay_days": 4, "subject": "{business_name}'s website on a phone", "body": "Hi, a quick follow-up. If a call is too much right now, just reply \"send it\" and I'll email you the three fixes I'd make first on {business_name}'s site, free, no call needed.\n\n{sender_name}"}, {"step": 3, "delay_days": 10, "subject": "{business_name}'s website on a phone", "body": "Hi, I'll close the file after this one. If the website or an AI policy for your staff becomes a priority for {business_name}, reply \"yes\" and I'll send a few times.\n\n{sender_name}"}]$j$::jsonb, true),
    '{touch_sets,legal}', $j$[{"step": 1, "delay_days": 0, "subject": "AI at {business_name}", "body": "Hi,\n\nA quick question for {business_name}: does the firm have a written policy for how staff use AI tools like ChatGPT? At a lot of small firms someone already uses them on client work, and the ABA's Formal Opinion 512 (2024) expects lawyers to understand and supervise that use.\n\nWe help small firms get ahead of it: a plain-English AI use policy, the right tools set up so client information stays protected, and a short training for the team. Fixed price, and the first conversation is free.{site_line}\n\nI'm Deven, and I run Wade Capital.\n\n{booking_line}\n\n{sender_name}"}]$j$::jsonb, true),
    '{followup_sets,legal}', $j$[{"step": 2, "delay_days": 4, "subject": "AI at {business_name}", "body": "Hi, a quick follow-up. If a call is too much right now, reply \"send it\" and I'll email you a one-page AI use policy starter for small firms, free, no call needed.\n\n{sender_name}"}, {"step": 3, "delay_days": 10, "subject": "AI at {business_name}", "body": "Hi, I'll close the file after this one. If an AI policy, safe AI tools, or the website becomes a priority for {business_name}, reply \"yes\" and I'll send a few times.\n\n{sender_name}"}]$j$::jsonb, true),
    '{problem_required_categories}', '["medical"]'::jsonb, true),
    '{first_email_categories}', '["medical", "legal"]'::jsonb, true),
    '{max_new_sends_per_run}', '6'::jsonb, true)
where key = 'outreach';
