-- Channels v3 settings (Sept 30, 2026). Applied by Claude via the Supabase
-- connection; saved here as a record.
--
-- 1. Outreach: approval switch removed; new first emails for
--    real-estate cash buyers (buyer_intro) and for owners who gave their
--    email on an AI call (after_call); buyer-specific follow-ups.
-- 2. phone_calls: AI calling config (Bland). Calls only start once the
--    BLAND_API_KEY GitHub secret exists.
-- 3. phone_screening: screen 150 numbers per run (about $1.20/run at Twilio's $0.008 each).
-- 4. real_estate: how many cash buyers to look up on Google per weekly run.

update settings set value = (value - 'require_notion_approval')
  || jsonb_build_object(
    'touch_sets', (value->'touch_sets') || jsonb_build_object(
      'buyer_intro', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', 'Baltimore properties',
        'body', E'Hi,\n\n{context}I''m Deven with Wade Capital. I find off-market houses in Baltimore City, mostly vacant and distressed rowhomes, and pass them to investors at a discount.\n\nWhat are you buying right now? If you tell me your neighborhoods, price range, and how much rehab you''ll take on, I''ll only send you deals that fit.\n\n{sender_name}')),
      'after_call', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', 'your sample website',
        'body', E'Hi,\n\nThanks for taking the call from my assistant. Here''s the free sample website I put together for {business_name}:\n\n{preview_url}\n\nIt''s built from your Google listing, so it''s just a starting point. If you like the direction, I can turn it into a real site with your photos, services, and a contact form, hosted and maintained for you at a fixed price.\n\nHappy to answer any questions, or we can do a quick 10-minute call this week.\n\n{sender_name}'))
    ),
    'followup_sets', coalesce(value->'followup_sets', '{}'::jsonb) || jsonb_build_object(
      'buyer_intro', jsonb_build_array(
        jsonb_build_object('step', 2, 'delay_days', 5,
          'body', E'Hi, following up in case this got buried. Even a one-line answer (neighborhoods and max price) helps me send you only the deals that fit.\n\n{sender_name}'),
        jsonb_build_object('step', 3, 'delay_days', 10,
          'body', E'Hi, last note from me. If you''re buying in Baltimore and want a first look at off-market deals, just reply with your criteria and I''ll add you to my list.\n\n{sender_name}')
      )
    )
  ),
  updated_at = now()
where key = 'outreach';

insert into settings (key, value) values ('phone_calls', jsonb_build_object(
  'enabled', true,
  'max_calls_per_run', 10,
  'monthly_budget_usd', 20,
  'est_cost_per_call_usd', 0.25,
  'max_attempts', 2,
  'retry_after_days', 3,
  'max_duration_min', 3,
  'call_days', jsonb_build_array(2, 3, 4),
  'start_hour', 10,
  'end_hour', 16,
  'timezone', 'America/New_York',
  'agent_name', 'Alex',
  'callback_number', '(703) 424-4201',
  'transfer_phone_number', null
))
on conflict (key) do update set value = excluded.value, updated_at = now();

insert into settings (key, value) values ('phone_screening', '{"max_per_run": 150}'::jsonb)
on conflict (key) do update set value = settings.value || excluded.value, updated_at = now();

insert into settings (key, value) values ('real_estate', '{"max_buyer_lookups_per_run": 15}'::jsonb)
on conflict (key) do update set value = settings.value || excluded.value, updated_at = now();
