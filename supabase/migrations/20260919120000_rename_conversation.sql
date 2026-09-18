-- -----------------------------------------------------------------------------
-- Renaming a conversation.
--
-- The `authenticated` role could read and delete its own conversations but not
-- change them, so a rename had nowhere to go. Rather than open the table up, the
-- grant is scoped to a single column: `title` is the only thing this role may ever
-- write. user_id, created_at and updated_at stay out of reach, so a rename cannot
-- move a conversation to another owner or forge its place in the list, and messages
-- remain entirely read-only.
--
-- The policy restricts it to the owner's own rows on both sides: `using` decides
-- which rows can be updated, `with check` refuses any update that would hand the row
-- to someone else. The existing check constraint on title (1–120 characters) keeps
-- an empty name out of the database whichever path writes it.
-- -----------------------------------------------------------------------------
grant update (title) on table public.conversations to authenticated;

create policy conversations_update_own on public.conversations
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
