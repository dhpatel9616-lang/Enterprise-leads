-- Lock the Enterprise project (skakrtljfaeopfqigyww) to the service key only.
-- Applied 2026-09-29. Supersedes the anon policies in
-- 20260928223000_private_business_mailing_address.sql and settings-schema.sql:
-- the public (anon) key can no longer read or write ANY table, including
-- settings. Every script uses the service key, so nothing that runs is
-- affected. The browser dashboards (dashboard/settings.html here, and
-- The Board's dashboard pages) were never configured with a key; if you ever
-- want them, they need a login first, not the anon key.

drop policy if exists "anon can read feedback" on public.feedback;
drop policy if exists "anon can insert feedback" on public.feedback;
drop policy if exists "anon can update item status" on public.items;
drop policy if exists "anon can read items" on public.items;
drop policy if exists "anon can read settings" on public.settings;
drop policy if exists "anon can update settings" on public.settings;
drop policy if exists "anon can read sources" on public.sources;
drop policy if exists "anon can read tag_weights" on public.tag_weights;

alter table public.feedback enable row level security;
alter table public.items enable row level security;
alter table public.settings enable row level security;
alter table public.sources enable row level security;
alter table public.tag_weights enable row level security;
alter table public.leads enable row level security;
alter table public.consulting_pipeline enable row level security;
alter table public.re_properties enable row level security;
alter table public.re_buyers enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
