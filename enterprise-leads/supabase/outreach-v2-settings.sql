-- Outreach v2 settings (Sept 2026). Apply AFTER the v2 code is pushed.
-- Claude applies this for you through the Supabase connection; it is
-- saved here so there is a record of exactly what changed.
--
-- 1. Email copy: short, plain, one specific observation + one offer +
--    one question. Four touches instead of six. The legal footer is added
--    by the code; the mailing address comes from the private
--    business_mailing_address row (set directly in the database, never here).
-- 2. Sending caps sized for one free Gmail inbox.
-- 3. Lead sourcing: 11 metro areas across PA, MD, VA, DC, with a hard
--    Google search cap that stays inside the free tier.

update settings set value = value
  || jsonb_build_object(
    'test_mode', false,
    'from_display_name', 'Deven Patel',
    'require_notion_approval', false,
    'preview_base_url', 'https://wadecapital.netlify.app/preview.html',
    'max_new_sends_per_run', 40,
    'max_followups_per_run', 50,
    'sender_name', E'Deven Patel\nWade Capital\nwadecapital.netlify.app | (703) 424-4201',
    'touch_sets', (value->'touch_sets') || jsonb_build_object(
      'website', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', '{business_name}''s website',
        'body', E'Hi,\n\nI came across {business_name} online and noticed your website {issue_line}. For a lot of local businesses, that is where people coming from Google drop off before they ever call.\n\nI''m Deven, and I run Wade Capital, a small studio that builds and manages websites for local businesses. Fixed price, usually live in about two weeks, and I handle hosting and updates so you don''t have to. I can also automate things like social media posting or online booking.\n\nWould it help if I sent over a quick mockup of what an updated site could look like? No cost to see it.\n\n{sender_name}')),
      'both', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', '{business_name}''s website',
        'body', E'Hi,\n\nI came across {business_name} online and noticed your website {issue_line}, and it doesn''t link to any social media accounts. Customers usually check both before they call or visit.\n\nI''m Deven, and I run Wade Capital, a small studio that builds websites for local businesses and sets up automatic social media posting, so your pages stay active without taking your time. Fixed price, usually live in about two weeks.\n\nWould it help if I sent over a quick mockup of an updated site? No cost to see it.\n\n{sender_name}')),
      'social', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', '{business_name} on social media',
        'body', E'Hi,\n\nI was on {business_name}''s website and noticed it {issue_line}. More and more customers check Instagram or Facebook before they visit, and a page that posts regularly is often what tips them.\n\nI''m Deven, and I run Wade Capital, a small studio that sets up automated social media posting for local businesses. We plan and schedule a month of posts at a time, so your pages stay active without you thinking about it.\n\nWant me to put together a sample week of posts for {business_name}? No cost.\n\n{sender_name}')),
      'no_website', jsonb_build_array(jsonb_build_object('step', 1, 'delay_days', 0,
        'subject', 'a website for {business_name}',
        'body', E'Hi,\n\nI was looking for {business_name} online and couldn''t find a website, so I put together a quick mockup of what one could look like:\n\n{preview_url}\n\nIt''s just a starting point built from your Google listing. If you like the direction, I can turn it into a real site with your photos, services, and a contact form, hosted and maintained for you at a fixed price. I can also set up automatic social media posting or online booking.\n\nWorth a 10-minute call this week?\n\n{sender_name}'))
    ),
    'followups', jsonb_build_array(
      jsonb_build_object('step', 2, 'delay_days', 4,
        'subject', '{business_name}''s website',
        'body', E'Hi, just bumping this in case it got buried. I''m happy to put together a free example of {offer_phrase} for {business_name} if that would be useful.\n\n{sender_name}'),
      jsonb_build_object('step', 3, 'delay_days', 7,
        'subject', '{business_name}''s website',
        'body', E'Hi, one more note on {offer_phrase}. If now isn''t a good time, no problem at all. If it helps, a 10-minute call is the easiest way to see whether it''s worth it.\n\n{sender_name}'),
      jsonb_build_object('step', 4, 'delay_days', 10,
        'subject', '{business_name}''s website',
        'body', E'Hi, I''ll stop following up after this one. If {offer_phrase} ever becomes a priority for {business_name}, just reply here and I''ll pick it up from there.\n\n{sender_name}')
    ),
    'automation_pivot', jsonb_build_object(
      'start_step', 3,
      'eligible_need_types', jsonb_build_array('website', 'social', 'both'),
      'touches', jsonb_build_array(
        jsonb_build_object('step', 3, 'delay_days', 7,
          'subject', '{business_name}''s website',
          'body', E'Hi,\n\nA different idea for {business_name}: most local businesses I talk to lose a few hours a week to follow-up texts, review requests, and appointment reminders that could run on their own.\n\nI do a fixed-fee Automation Readiness Audit: a short call and a written list of what''s worth automating first, with no commitment to build anything.\n\nWant me to send the details?\n\n{sender_name}'),
        jsonb_build_object('step', 4, 'delay_days', 10,
          'subject', '{business_name}''s website',
          'body', E'Hi, I''ll stop following up after this one. If a website refresh or the automation audit ever becomes a priority for {business_name}, just reply here and I''ll pick it up from there.\n\n{sender_name}')
      )
    )
  ),
  updated_at = now()
where key = 'outreach';

-- Old unused key from the draft era.
update settings set value = value - 'max_sends_per_run' - 'postal_address' where key = 'outreach';

update settings set value = value || jsonb_build_object(
    'max_new_leads_per_run', 120,
    'max_searches_per_run', 40,
    'monthly_search_cap', 950,
    'max_per_combo_per_run', 8,
    'locations', jsonb_build_array(
      jsonb_build_object('name', 'State College, PA', 'lat', 40.7982, 'lng', -77.8599, 'radius_meters', 36000),
      jsonb_build_object('name', 'Altoona, PA', 'lat', 40.5187, 'lng', -78.3947, 'radius_meters', 15000),
      jsonb_build_object('name', 'Harrisburg, PA', 'lat', 40.2732, 'lng', -76.8867, 'radius_meters', 20000),
      jsonb_build_object('name', 'Pittsburgh, PA', 'lat', 40.4406, 'lng', -79.9959, 'radius_meters', 20000),
      jsonb_build_object('name', 'Washington, DC', 'lat', 38.9072, 'lng', -77.0369, 'radius_meters', 25000),
      jsonb_build_object('name', 'Arlington, VA', 'lat', 38.8816, 'lng', -77.0910, 'radius_meters', 25000),
      jsonb_build_object('name', 'Alexandria, VA', 'lat', 38.8048, 'lng', -77.0469, 'radius_meters', 12000),
      jsonb_build_object('name', 'Fairfax, VA', 'lat', 38.8462, 'lng', -77.3064, 'radius_meters', 20000),
      jsonb_build_object('name', 'Baltimore, MD', 'lat', 39.2904, 'lng', -76.6122, 'radius_meters', 20000),
      jsonb_build_object('name', 'Silver Spring, MD', 'lat', 38.9907, 'lng', -77.0261, 'radius_meters', 15000),
      jsonb_build_object('name', 'Annapolis, MD', 'lat', 38.9784, 'lng', -76.4922, 'radius_meters', 15000)
    ),
    'categories', (
      select jsonb_agg(case when c->>'search_term' = 'bars near Penn State University'
                            then jsonb_build_object('category', 'bar', 'search_term', 'bars and pubs')
                            else c end)
      from jsonb_array_elements(value->'categories') c
    )
  ),
  updated_at = now()
where key = 'places_queries';

update settings set value = value || '{"max_leads_per_run": 120}'::jsonb, updated_at = now() where key = 'email_enrichment';
update settings set value = value || '{"call_list_size": 15, "subject_prefix": "Enterprise Leads:"}'::jsonb, updated_at = now() where key = 'digest';
