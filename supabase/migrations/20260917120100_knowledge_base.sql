-- =============================================================================
-- Knowledge base: QOBO website chunks + embeddings (pgvector).
--
-- Tables live in `private` (not exposed by the Data API). Ingestion writes them
-- through a direct Postgres connection; the API reads them only through
-- `match_kb_chunks` / `get_kb_meta`, which only `service_role` can execute.
-- The vector dimension (768) must match EMBEDDING_DIM in api/src/rag.
-- =============================================================================

create extension if not exists vector with schema extensions;

create table private.kb_chunks (
  id bigint generated always as identity primary key,
  url text not null,
  title text not null,
  page_type text not null,
  section text,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  topics text[] not null default '{}',
  token_estimate integer not null check (token_estimate > 0),
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  unique (url, chunk_index)
);

create index kb_chunks_embedding_hnsw_idx on private.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Single-row table describing the currently loaded knowledge base. The API
-- refuses to start if its embedding model/dimension does not match.
create table private.kb_meta (
  id boolean primary key default true check (id),
  embedding_model text not null,
  embedding_dim integer not null check (embedding_dim > 0),
  chunk_count integer not null check (chunk_count >= 0),
  crawled_at timestamptz not null,
  snapshot_ref text,
  updated_at timestamptz not null default now()
);

alter table private.kb_chunks enable row level security;
alter table private.kb_meta enable row level security;

revoke all on table private.kb_chunks, private.kb_meta from public, anon, authenticated;
grant select on table private.kb_chunks, private.kb_meta to service_role;

-- -----------------------------------------------------------------------------
-- match_kb_chunks: cosine-similarity search, best matches first.
-- -----------------------------------------------------------------------------
create function public.match_kb_chunks(
  p_query_embedding extensions.vector(768),
  p_match_count integer default 5,
  p_min_similarity double precision default 0
)
returns table (
  id bigint,
  url text,
  title text,
  section text,
  page_type text,
  content text,
  topics text[],
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.url,
    c.title,
    c.section,
    c.page_type,
    c.content,
    c.topics,
    1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from private.kb_chunks c
  where 1 - (c.embedding operator(extensions.<=>) p_query_embedding) >= coalesce(p_min_similarity, 0)
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(coalesce(p_match_count, 5), 1), 20);
$$;

create function public.get_kb_meta()
returns table (
  embedding_model text,
  embedding_dim integer,
  chunk_count integer,
  crawled_at timestamptz,
  snapshot_ref text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.embedding_model, m.embedding_dim, m.chunk_count, m.crawled_at, m.snapshot_ref
  from private.kb_meta m;
$$;

revoke all on function public.match_kb_chunks(extensions.vector, integer, double precision) from public, anon, authenticated;
revoke all on function public.get_kb_meta() from public, anon, authenticated;
grant execute on function public.match_kb_chunks(extensions.vector, integer, double precision) to service_role;
grant execute on function public.get_kb_meta() to service_role;
