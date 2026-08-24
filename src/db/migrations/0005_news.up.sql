-- =============================================================================
-- 0005_news
--
-- News ingestion, clustering, entity-level sentiment and the knowledge graph
-- (IMPLEMENTATION_PLAN §5, §11).
--
-- Reference/market data: world-readable to authenticated users, writable only
-- by service_role (see 0007).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type news_event_status as enum ('active', 'settled', 'merged', 'suppressed');

create type news_entity_type as enum (
  'asset', 'team', 'player', 'company', 'person', 'organization',
  'country', 'sector', 'regulator', 'other'
);

-- -----------------------------------------------------------------------------
-- news_sources
-- -----------------------------------------------------------------------------
create table news_sources (
  id           uuid primary key default gen_random_uuid(),
  provider_id  text not null,
  external_id  text not null,
  name         text not null,
  homepage_url text,
  feed_url     text,
  reliability  reliability_class not null default 'SECONDARY',
  country      text,
  language     text not null default 'en',
  is_enabled   boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider_id, external_id)
);

create trigger news_sources_set_updated_at
  before update on news_sources
  for each row execute function set_updated_at();

comment on column news_sources.reliability is
  'Drives both the importance score and rumour handling: a cluster whose sources are all SOCIAL/UNVERIFIED is rendered as an unverified report and is excluded from the news model feature vector entirely (§11).';

-- -----------------------------------------------------------------------------
-- news_articles
-- -----------------------------------------------------------------------------
create table news_articles (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references news_sources(id) on delete cascade,
  external_id  text not null,
  url          text not null,
  -- sha256 of the normalised URL (scheme/host lowercased, tracking params
  -- stripped). A second, independent dedup guard: syndicated copies share a
  -- canonical URL even when their provider ids differ.
  url_hash     text not null,
  title        text not null,
  author       text,
  published_at timestamptz not null,
  fetched_at   timestamptz not null default now(),
  summary      text,
  body         text,
  category     text,
  image_url    text,
  language     text not null default 'en',
  -- 64-bit locality-sensitive hash of the body, for near-duplicate detection
  -- (rewritten wire copy) where url_hash cannot help.
  simhash      bigint,
  created_at   timestamptz not null default now(),
  -- Primary idempotency guard for ingestion.
  unique (source_id, external_id),
  -- Secondary dedup guard across sources.
  unique (url_hash)
);

create index news_articles_published_idx on news_articles (published_at desc);
create index news_articles_source_published_idx on news_articles (source_id, published_at desc);
create index news_articles_simhash_idx on news_articles (simhash) where simhash is not null;

-- Full-text search over title + summary. Generated (not trigger-maintained) so
-- it cannot drift from its inputs; `to_tsvector` with an explicit, constant
-- regconfig is IMMUTABLE, which is what makes a generated column legal here.
alter table news_articles
  add column search_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
  ) stored;

create index news_articles_search_gin_idx on news_articles using gin (search_tsv);

comment on column news_articles.search_tsv is
  'Generated tsvector over title + summary, GIN-indexed. Body is deliberately excluded: it triples index size for a large drop in precision on a headline-driven product.';
comment on column news_articles.body is
  'Full text when the provider supplies it. May be NULL — the pipeline must degrade to title+summary rather than skipping the article.';

-- Embeddings live behind the pgvector guard from 0001. When the extension is
-- unavailable the column simply does not exist and the clustering step falls
-- back to lexical similarity (simhash + shared entities). The repository layer
-- checks for the column before selecting it.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'alter table news_articles add column embedding vector(384)';
    execute $ix$
      create index news_articles_embedding_idx on news_articles
        using ivfflat (embedding vector_cosine_ops) with (lists = 100)
    $ix$;
  else
    raise notice 'pgvector absent — news_articles.embedding not created; clustering will use lexical similarity.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- news_events  — clusters
-- -----------------------------------------------------------------------------
create table news_events (
  id                       uuid primary key default gen_random_uuid(),
  cluster_key              text not null unique,
  title                    text not null,
  summary                  text,
  category                 text,
  status                   news_event_status not null default 'active',
  merged_into_id           uuid references news_events(id) on delete set null,
  first_seen_at            timestamptz not null,
  last_seen_at             timestamptz not null,
  article_count            integer not null default 0 check (article_count >= 0),
  -- The count of INDEPENDENT sources, not the article count. Twelve outlets
  -- covering one Fed decision is one event with twelve sources, and it is the
  -- independence that carries the credibility signal (§11).
  independent_source_count integer not null default 0 check (independent_source_count >= 0),
  highest_reliability      reliability_class,
  importance               numeric(5, 2) check (importance is null or (importance >= 0 and importance <= 100)),
  is_breaking              boolean not null default false,
  -- Independent sources per hour. Breaking is detected from this, never from
  -- the word "BREAKING" appearing in a headline.
  velocity                 numeric(10, 4),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint news_events_seen_order check (last_seen_at >= first_seen_at)
);

create trigger news_events_set_updated_at
  before update on news_events
  for each row execute function set_updated_at();

create index news_events_active_idx on news_events (last_seen_at desc) where status = 'active';
create index news_events_importance_idx on news_events (importance desc nulls last, last_seen_at desc);

comment on column news_events.velocity is
  'Independent sources per hour. The breaking detector fires on a spike in this value for a NEW cluster.';
comment on column news_events.merged_into_id is
  'Set when incremental clustering later discovers two clusters were the same story. The loser keeps its rows and points here; nothing is deleted.';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'alter table news_events add column centroid vector(384)';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- news_event_articles  (join table -> composite PK)
-- -----------------------------------------------------------------------------
create table news_event_articles (
  event_id   uuid not null references news_events(id) on delete cascade,
  article_id uuid not null references news_articles(id) on delete cascade,
  similarity numeric(7, 6) check (similarity is null or (similarity >= -1 and similarity <= 1)),
  is_seed    boolean not null default false,
  added_at   timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (event_id, article_id)
);

create index news_event_articles_article_idx on news_event_articles (article_id);

-- -----------------------------------------------------------------------------
-- news_entities
-- -----------------------------------------------------------------------------
create table news_entities (
  id           uuid primary key default gen_random_uuid(),
  entity_key   text not null unique,
  entity_type  news_entity_type not null,
  display_name text not null,
  aliases      text[] not null default '{}',
  -- Resolution into the rest of the system. Both nullable: most entities are
  -- neither a tradable asset nor a team.
  asset_id     uuid references assets(id) on delete set null,
  team_id      uuid references teams(id) on delete set null,
  importance   numeric(5, 2) check (importance is null or (importance >= 0 and importance <= 100)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger news_entities_set_updated_at
  before update on news_entities
  for each row execute function set_updated_at();

create index news_entities_asset_idx on news_entities (asset_id) where asset_id is not null;
create index news_entities_team_idx on news_entities (team_id) where team_id is not null;

comment on column news_entities.entity_key is
  'Canonical slug (crypto:BTC, org:sec, team:arsenal). Resolution happens once at extraction time so downstream joins never string-match a display name.';

-- -----------------------------------------------------------------------------
-- news_article_entities  (join table -> composite PK)
-- -----------------------------------------------------------------------------
create table news_article_entities (
  article_id    uuid not null references news_articles(id) on delete cascade,
  entity_id     uuid not null references news_entities(id) on delete cascade,
  relevance     numeric(7, 6) not null default 1 check (relevance >= 0 and relevance <= 1),
  mention_count smallint not null default 1 check (mention_count > 0),
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (article_id, entity_id)
);

create index news_article_entities_entity_idx on news_article_entities (entity_id);

-- -----------------------------------------------------------------------------
-- news_entity_sentiment
-- -----------------------------------------------------------------------------
create table news_entity_sentiment (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references news_entities(id) on delete cascade,
  article_id    uuid references news_articles(id) on delete cascade,
  event_id      uuid references news_events(id) on delete cascade,
  sentiment     numeric(7, 6) not null check (sentiment >= -1 and sentiment <= 1),
  magnitude     numeric(7, 6) not null default 0 check (magnitude >= 0 and magnitude <= 1),
  rationale     text,
  model_version text not null,
  computed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  -- Attached to exactly one of an article or a cluster, never both, never
  -- neither.
  constraint news_entity_sentiment_one_parent check (
    num_nonnulls(article_id, event_id) = 1
  )
);

create unique index news_entity_sentiment_article_uidx
  on news_entity_sentiment (entity_id, article_id, model_version)
  where article_id is not null;
create unique index news_entity_sentiment_event_uidx
  on news_entity_sentiment (entity_id, event_id, model_version)
  where event_id is not null;

comment on table news_entity_sentiment is
  'Sentiment is PER ENTITY, never per article. "Regulator fines Exchange X" is bearish for X, mildly bullish for a compliant competitor and neutral overall; an article-level score averages that into mush (§11).';
comment on column news_entity_sentiment.magnitude is
  'Strength of the sentiment signal, independent of its direction. Volume and direction are tracked separately so the model cannot mistake loudness for bullishness (§18-R9).';

-- -----------------------------------------------------------------------------
-- entity_graph_nodes
-- -----------------------------------------------------------------------------
create table entity_graph_nodes (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null unique references news_entities(id) on delete cascade,
  weight     numeric(10, 6) not null default 0,
  degree     integer not null default 0,
  metadata   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create trigger entity_graph_nodes_set_updated_at
  before update on entity_graph_nodes
  for each row execute function set_updated_at();

comment on table entity_graph_nodes is
  'Materialised node view of an entity in the knowledge graph. Separate from news_entities so graph-maintenance writes do not churn the entity registry every article.';

-- -----------------------------------------------------------------------------
-- entity_graph_edges  (composite PK, no surrogate id)
-- -----------------------------------------------------------------------------
create table entity_graph_edges (
  source_node_id uuid not null references entity_graph_nodes(id) on delete cascade,
  target_node_id uuid not null references entity_graph_nodes(id) on delete cascade,
  relation       text not null,
  weight         numeric(10, 6) not null default 0,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (source_node_id, target_node_id, relation),
  constraint entity_graph_edges_no_self_loop check (source_node_id <> target_node_id)
);

create index entity_graph_edges_target_idx on entity_graph_edges (target_node_id, relation);
create index entity_graph_edges_weight_idx on entity_graph_edges (weight desc);

comment on column entity_graph_edges.evidence_count is
  'Number of independent observations supporting this edge. An edge seen once is rendered as a hypothesis; the UI never draws a one-article co-occurrence as an established relationship.';
