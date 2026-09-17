-- =============================================================================
-- Chat schema: conversations, messages, usage quotas.
--
-- Security model
--   * The browser holds the publishable key + the user's JWT, so it can reach the
--     Data API directly. Therefore `authenticated` may only READ its own rows and
--     DELETE its own conversations. It can never INSERT or UPDATE, so it cannot
--     forge assistant messages or bypass quotas.
--   * All writes go through the backend (secret key → `service_role`) via the
--     functions below, which take user_id only from a server-verified JWT.
--   * Supabase grants CRUD on new `public` tables and EXECUTE on new functions to
--     anon/authenticated by default, so every object here revokes explicitly and
--     grants the minimum.
--   * Internal tables live in the `private` schema, which is not exposed by the
--     Data API. Callable functions stay in `public` (the exposed schema) but are
--     executable by `service_role` only.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to service_role;

-- -----------------------------------------------------------------------------
-- conversations
-- -----------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for the composite foreign key on messages (owner consistency).
  unique (id, user_id)
);

create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  -- Monotonic ordering that does not depend on clock resolution.
  seq bigint generated always as identity,
  conversation_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  intent text check (intent in ('qobo', 'general', 'off_topic', 'smalltalk')),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  -- Client-generated idempotency key (user messages only).
  client_message_id uuid,
  created_at timestamptz not null default now(),
  -- A message's user_id must match its conversation's owner.
  foreign key (conversation_id, user_id) references public.conversations (id, user_id) on delete cascade,
  check ((role = 'user') = (client_message_id is not null)),
  check (role = 'assistant' or intent is null)
);

create index messages_conversation_seq_idx on public.messages (conversation_id, seq);
create index messages_user_idx on public.messages (user_id);
create unique index messages_user_client_message_uidx on public.messages (user_id, client_message_id)
  where client_message_id is not null;

-- -----------------------------------------------------------------------------
-- private usage counters (independent of conversations, so deleting a chat
-- does not reset a quota)
-- -----------------------------------------------------------------------------
create table private.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  kind text not null check (kind in ('message')),
  count integer not null default 0 check (count >= 0),
  primary key (user_id, usage_date, kind)
);

create table private.usage_global_daily (
  usage_date date not null,
  kind text not null check (kind in ('web_search')),
  count integer not null default 0 check (count >= 0),
  primary key (usage_date, kind)
);

-- -----------------------------------------------------------------------------
-- Row Level Security + grants
-- -----------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table private.usage_daily enable row level security;
alter table private.usage_global_daily enable row level security;

revoke all on table public.conversations, public.messages from public, anon, authenticated;
revoke all on table private.usage_daily, private.usage_global_daily from public, anon, authenticated;

grant select, delete on table public.conversations to authenticated;
grant select on table public.messages to authenticated;

grant select, insert, update, delete on table public.conversations, public.messages to service_role;
grant select, insert, update, delete on table private.usage_daily, private.usage_global_daily to service_role;

do $$
declare
  seq_name text := pg_get_serial_sequence('public.messages', 'seq');
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', seq_name);
  execute format('grant usage, select on sequence %s to service_role', seq_name);
end;
$$;

create policy conversations_select_own on public.conversations
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy conversations_delete_own on public.conversations
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy messages_select_own on public.messages
  for select to authenticated
  using (user_id = (select auth.uid()));

-- No INSERT/UPDATE policies exist for authenticated, and no grants either.
-- Messages are removed only through the conversation delete cascade.

-- -----------------------------------------------------------------------------
-- get_exchange: look up a previously stored exchange by idempotency key
-- -----------------------------------------------------------------------------
create function public.get_exchange(p_user_id uuid, p_client_message_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_message public.messages;
  v_assistant_message public.messages;
begin
  select m.* into v_user_message
  from public.messages m
  where m.user_id = p_user_id
    and m.client_message_id = p_client_message_id;

  if not found then
    return null;
  end if;

  select m.* into v_assistant_message
  from public.messages m
  where m.conversation_id = v_user_message.conversation_id
    and m.role = 'assistant'
    and m.seq > v_user_message.seq
  order by m.seq
  limit 1;

  return jsonb_build_object(
    'conversation_id', v_user_message.conversation_id,
    'replayed', true,
    'user_message', to_jsonb(v_user_message),
    'assistant_message', to_jsonb(v_assistant_message)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- append_exchange: atomically store a user message and the assistant reply.
-- Creates the conversation when p_conversation_id is null. Idempotent on
-- (p_user_id, p_client_message_id). Raises P0002 when the conversation does not
-- exist or belongs to someone else.
-- -----------------------------------------------------------------------------
create function public.append_exchange(
  p_user_id uuid,
  p_conversation_id uuid,
  p_client_message_id uuid,
  p_title text,
  p_user_content text,
  p_assistant_content text,
  p_intent text,
  p_sources jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_conversation_id uuid;
  v_user_message public.messages;
  v_assistant_message public.messages;
begin
  if p_user_id is null or p_client_message_id is null then
    raise exception 'p_user_id and p_client_message_id are required' using errcode = '22004';
  end if;

  v_existing := public.get_exchange(p_user_id, p_client_message_id);
  if v_existing is not null then
    return v_existing;
  end if;

  begin
    if p_conversation_id is null then
      insert into public.conversations (user_id, title)
      values (p_user_id, left(coalesce(nullif(btrim(p_title), ''), 'New conversation'), 120))
      returning id into v_conversation_id;
    else
      update public.conversations
      set updated_at = now()
      where id = p_conversation_id
        and user_id = p_user_id
      returning id into v_conversation_id;

      if v_conversation_id is null then
        raise exception 'conversation not found' using errcode = 'P0002';
      end if;
    end if;

    insert into public.messages (conversation_id, user_id, role, content, client_message_id)
    values (v_conversation_id, p_user_id, 'user', p_user_content, p_client_message_id)
    returning * into v_user_message;

    insert into public.messages (conversation_id, user_id, role, content, intent, sources, metadata)
    values (
      v_conversation_id,
      p_user_id,
      'assistant',
      p_assistant_content,
      p_intent,
      coalesce(p_sources, '[]'::jsonb),
      coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into v_assistant_message;
  exception
    when unique_violation then
      -- A concurrent request with the same idempotency key committed first.
      v_existing := public.get_exchange(p_user_id, p_client_message_id);
      if v_existing is null then
        raise;
      end if;
      return v_existing;
  end;

  return jsonb_build_object(
    'conversation_id', v_conversation_id,
    'replayed', false,
    'user_message', to_jsonb(v_user_message),
    'assistant_message', to_jsonb(v_assistant_message)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- consume_user_quota: atomically count one unit of a per-user daily quota.
-- Returns allowed = false (without incrementing) once the limit is reached.
-- -----------------------------------------------------------------------------
create function public.consume_user_quota(p_user_id uuid, p_kind text, p_limit integer)
returns table (allowed boolean, used integer, quota_limit integer)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;

  if coalesce(p_limit, 0) > 0 then
    insert into private.usage_daily as u (user_id, usage_date, kind, count)
    values (p_user_id, v_today, p_kind, 1)
    on conflict (user_id, usage_date, kind)
      do update set count = u.count + 1
      where u.count < p_limit
    returning u.count into v_used;

    if v_used is not null then
      return query select true, v_used, p_limit;
      return;
    end if;
  end if;

  select u.count into v_used
  from private.usage_daily u
  where u.user_id = p_user_id and u.usage_date = v_today and u.kind = p_kind;

  return query select false, coalesce(v_used, 0), coalesce(p_limit, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- consume_global_quota: same as above for app-wide daily limits (web search).
-- -----------------------------------------------------------------------------
create function public.consume_global_quota(p_kind text, p_limit integer)
returns table (allowed boolean, used integer, quota_limit integer)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  if coalesce(p_limit, 0) > 0 then
    insert into private.usage_global_daily as u (usage_date, kind, count)
    values (v_today, p_kind, 1)
    on conflict (usage_date, kind)
      do update set count = u.count + 1
      where u.count < p_limit
    returning u.count into v_used;

    if v_used is not null then
      return query select true, v_used, p_limit;
      return;
    end if;
  end if;

  select u.count into v_used
  from private.usage_global_daily u
  where u.usage_date = v_today and u.kind = p_kind;

  return query select false, coalesce(v_used, 0), coalesce(p_limit, 0);
end;
$$;

revoke all on function public.get_exchange(uuid, uuid) from public, anon, authenticated;
revoke all on function public.append_exchange(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.consume_user_quota(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.consume_global_quota(text, integer) from public, anon, authenticated;

grant execute on function public.get_exchange(uuid, uuid) to service_role;
grant execute on function public.append_exchange(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.consume_user_quota(uuid, text, integer) to service_role;
grant execute on function public.consume_global_quota(text, integer) to service_role;
