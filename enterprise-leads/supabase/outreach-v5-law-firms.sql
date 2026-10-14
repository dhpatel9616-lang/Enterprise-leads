-- Outreach v5 (owner, 2026-10-14): law firms lead with after-hours intake
-- voice agents and deadline/docket tracking, with AI governance (Rules 1.1,
-- 1.6, 5.3) as the trust layer. Replaces the long governance-audit email
-- (~250 words) with a short one, and gives law firms their own follow-ups
-- (they used to get the website follow-ups). Copy only; caps and switches are
-- unchanged. Re-runnable: it overwrites the same keys each time.
--
-- Honesty lines kept on purpose: the voice agent says it's an AI and never
-- gives legal advice; the firm still confirms every deadline.
-- The mailing address is added by the code from the private
-- business_mailing_address row, never written here.

update settings set value = jsonb_set(
    jsonb_set(value, '{touch_sets,governance_audit}', $j$[{"step": 1, "delay_days": 0,
      "subject": "after-hours calls and court deadlines at {business_name}",
      "body": "Hi,\n\nTwo things quietly cost small firms the most: the new-client call at 7 p.m. that goes to voicemail (and often on to the next firm on Google), and court deadlines that live in one person's inbox.\n\nI'm Deven, and I run Wade Capital with a few Penn State Business, IT, and Law students. For law firms we set up:\n- an after-hours intake agent that answers every call, says it's an AI, takes the caller's details and matter type, flags anything urgent, and emails you a summary (it never gives legal advice)\n- deadline and docket tracking: every court date and filing deadline in one calendar, with reminders to the attorney and a backup\n- a written AI use policy, so staff use these tools within Rules 1.1, 1.6 and 5.3\n\n{context}Each is a fixed price. Worth a 15-minute call to see which would help {business_name} most?\n\n{sender_name}"}]$j$::jsonb),
    '{followup_sets,governance_audit}', $j$[
      {"step": 2, "delay_days": 4, "subject": "after-hours calls at {business_name}",
       "body": "Hi, bumping this in case it got buried.\n\nHere's what the intake agent looks like in practice: someone calls {business_name} at 9 p.m., hears that they've reached an AI assistant for the firm, gives their name, number and what happened, and you have a summary in your inbox before morning, with anything urgent flagged at the top. No calls lost to voicemail, and no legal advice given.\n\nHappy to walk you through how it would sound for {business_name} on a 15-minute call.\n\n{sender_name}"},
      {"step": 3, "delay_days": 7, "subject": "court deadlines at {business_name}",
       "body": "Hi, one more idea: deadline and docket tracking.\n\nWe put every court date, filing deadline and limitations date your team enters into one shared calendar, with reminders at 30, 7 and 1 days to the responsible attorney and a backup person. Your team still confirms every date; the system makes sure nobody forgets one.\n\nWant me to send a one-page overview?\n\n{sender_name}"},
      {"step": 4, "delay_days": 10, "subject": "court deadlines at {business_name}",
       "body": "Hi, I'll stop following up after this one. If after-hours intake, deadline tracking, or an AI use policy ever becomes a priority for {business_name}, just reply here and I'll pick it up from there.\n\n{sender_name}"}
    ]$j$::jsonb, true)
where key = 'outreach';
