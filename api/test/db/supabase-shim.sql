-- Minimal emulation of the Supabase environment for running migrations in PGlite.
-- It reproduces what matters for security tests:
--   * the anon / authenticated / service_role roles (service_role bypasses RLS)
--   * auth.users and auth.uid() driven by request.jwt.claims
--   * Supabase's permissive DEFAULT PRIVILEGES on the public schema, so tests
--     prove the migrations' explicit revokes actually take effect.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create schema extensions;

grant usage on schema public, auth, extensions to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text unique
);

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
