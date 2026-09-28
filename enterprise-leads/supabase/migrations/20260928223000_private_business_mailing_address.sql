-- Keep the business mailing address private.
-- The settings page uses the public anon key, and the old policies let that
-- key read and update every settings row. The address now lives in its own
-- row, `business_mailing_address` (a JSON string), which only the
-- outreach job (service key, bypasses RLS) can read. Safe to re-run.
-- Project: Enterprise, skakrtljfaeopfqigyww.

drop policy if exists "anon can read settings" on settings;
drop policy if exists "anon can update settings" on settings;
create policy "anon can read settings" on settings for select using (key <> 'business_mailing_address');
create policy "anon can update settings" on settings for update
  using (key <> 'business_mailing_address') with check (key <> 'business_mailing_address');

-- Remove the old copy stored inside the (anon-readable) outreach settings.
update settings set value = value - 'physical_address' where key = 'outreach' and value ? 'physical_address';

-- The address itself is added by the owner in the SQL Editor, never in this
-- public repo:
--   insert into settings (key, value) values ('business_mailing_address', to_jsonb('<address>'::text))
--   on conflict (key) do update set value = excluded.value, updated_at = now();
