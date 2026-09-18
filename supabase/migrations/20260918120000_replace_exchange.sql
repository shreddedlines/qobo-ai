-- -----------------------------------------------------------------------------
-- replace_exchange: atomically replace one saved exchange with a new one.
--
-- Editing a message has to change what is stored, not add a second version, and it
-- has to keep the exchange where it was in the conversation. Ordering comes from
-- messages.seq, which is `generated always as identity`, so a delete-and-reinsert
-- would move the exchange to the end. Both rows are therefore updated in place:
-- seq is untouched, the position is preserved for free, and message ids stay stable
-- (citation anchors keep pointing at the same message).
--
-- Same guarantees as append_exchange:
--   * user_id comes from the verified token; ownership is checked here, in Postgres
--   * idempotent on (p_user_id, p_client_message_id), so a retry replays
--   * one transaction: either both messages change or neither does
--
-- Raises P0002 when the conversation does not exist or belongs to someone else, and
-- P0003 when the target message does not exist, is not in that conversation, or is
-- not the person's own message. An assistant message can never be edited: the lookup
-- requires role = 'user'.
-- -----------------------------------------------------------------------------
create function public.replace_exchange(
  p_user_id uuid,
  p_conversation_id uuid,
  p_target_message_id uuid,
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
  v_first_seq bigint;
begin
  if p_user_id is null or p_client_message_id is null or p_target_message_id is null or p_conversation_id is null then
    raise exception 'p_user_id, p_conversation_id, p_target_message_id and p_client_message_id are required' using errcode = '22004';
  end if;

  -- A retry of the same edit returns what was stored, without touching anything.
  v_existing := public.get_exchange(p_user_id, p_client_message_id);
  if v_existing is not null then
    return v_existing;
  end if;

  begin
    -- The message being edited: the person's own, in this conversation, never a reply.
    select m.* into v_user_message
    from public.messages m
    where m.id = p_target_message_id
      and m.user_id = p_user_id
      and m.conversation_id = p_conversation_id
      and m.role = 'user'
    for update;

    if not found then
      raise exception 'message not found' using errcode = 'P0003';
    end if;

    -- The reply that belongs to it: the first assistant message after it, which is
    -- the same rule get_exchange uses to pair an exchange up.
    select m.* into v_assistant_message
    from public.messages m
    where m.conversation_id = v_user_message.conversation_id
      and m.role = 'assistant'
      and m.seq > v_user_message.seq
    order by m.seq
    limit 1
    for update;

    update public.conversations
    set updated_at = now()
    where id = p_conversation_id
      and user_id = p_user_id
    returning id into v_conversation_id;

    if v_conversation_id is null then
      raise exception 'conversation not found' using errcode = 'P0002';
    end if;

    -- The title was derived from the first message, so editing that message retitles
    -- the conversation; editing a later one leaves the title alone.
    select min(m.seq) into v_first_seq
    from public.messages m
    where m.conversation_id = p_conversation_id;

    if v_first_seq = v_user_message.seq and nullif(btrim(coalesce(p_title, '')), '') is not null then
      update public.conversations
      set title = left(btrim(p_title), 120)
      where id = p_conversation_id
        and user_id = p_user_id;
    end if;

    update public.messages
    set content = p_user_content,
        client_message_id = p_client_message_id
    where id = v_user_message.id
    returning * into v_user_message;

    if v_assistant_message.id is null then
      -- No reply was stored for this message, which append_exchange never produces.
      -- Writing one keeps the exchange whole rather than leaving a question unanswered.
      insert into public.messages (conversation_id, user_id, role, content, intent, sources, metadata)
      values (
        v_user_message.conversation_id,
        p_user_id,
        'assistant',
        p_assistant_content,
        p_intent,
        coalesce(p_sources, '[]'::jsonb),
        coalesce(p_metadata, '{}'::jsonb)
      )
      returning * into v_assistant_message;
    else
      update public.messages
      set content = p_assistant_content,
          intent = p_intent,
          sources = coalesce(p_sources, '[]'::jsonb),
          metadata = coalesce(p_metadata, '{}'::jsonb)
      where id = v_assistant_message.id
      returning * into v_assistant_message;
    end if;
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

revoke all on function public.replace_exchange(uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_exchange(uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) to service_role;
