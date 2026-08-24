-- =============================================================================
-- 0003_sports
--
-- Reference + market data for the sports domain (IMPLEMENTATION_PLAN §5, §9).
-- Nothing here is org-owned: fixtures and box scores are facts about the world.
-- They are world-readable to authenticated users and writable only by
-- service_role (see 0007).
--
-- Every table carries the (provider_id, external_id) natural key of the vendor
-- that supplied it, with a UNIQUE constraint, so every ingestion job is a plain
-- `insert ... on conflict do update` and re-running it is free.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- Mirrors GameStatus in src/providers/types.ts.
create type game_status as enum ('scheduled', 'live', 'finished', 'postponed', 'cancelled');

-- Mirrors Injury['status'].
create type injury_status as enum ('out', 'doubtful', 'questionable', 'probable', 'suspended');

-- Mirrors TeamGameStats['result'].
create type game_result as enum ('W', 'D', 'L');

create type rating_system as enum ('elo', 'glicko2', 'form_score', 'team_strength');

-- -----------------------------------------------------------------------------
-- sports
-- -----------------------------------------------------------------------------
create table sports (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  is_enabled  boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on column sports.key is
  'Matches SportKey in src/providers/types.ts (football, basketball, ...). Phase 2 ships football only; the rest exist so adding a sport is data plus an engine config, not a migration.';

-- -----------------------------------------------------------------------------
-- leagues
-- -----------------------------------------------------------------------------
create table leagues (
  id             uuid primary key default gen_random_uuid(),
  sport_id       uuid not null references sports(id) on delete cascade,
  provider_id    text not null,
  external_id    text not null,
  name           text not null,
  country        text,
  tier           smallint,
  current_season text,
  is_tracked     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (provider_id, external_id)
);

create trigger leagues_set_updated_at
  before update on leagues
  for each row execute function set_updated_at();

create index leagues_sport_idx on leagues (sport_id);

comment on column leagues.is_tracked is
  'Prove the engine on one free league before paying for a thousand (§18-R7). Only tracked leagues are polled.';

-- -----------------------------------------------------------------------------
-- seasons
-- -----------------------------------------------------------------------------
create table seasons (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  label      text not null,
  start_date date,
  end_date   date,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, label),
  constraint seasons_date_order check (end_date is null or start_date is null or end_date >= start_date)
);

create unique index seasons_one_current_uidx on seasons (league_id) where is_current;

-- -----------------------------------------------------------------------------
-- teams
-- -----------------------------------------------------------------------------
create table teams (
  id          uuid primary key default gen_random_uuid(),
  sport_id    uuid not null references sports(id) on delete cascade,
  league_id   uuid references leagues(id) on delete set null,
  provider_id text not null,
  external_id text not null,
  name        text not null,
  short_name  text,
  country     text,
  crest_url   text,
  founded     smallint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (provider_id, external_id)
);

create trigger teams_set_updated_at
  before update on teams
  for each row execute function set_updated_at();

create index teams_league_idx on teams (league_id);
create index teams_name_idx on teams (lower(name));

comment on column teams.league_id is
  'Current league. Nullable and ON DELETE SET NULL because relegation, expansion and provider reshuffles must never cascade a team out of existence — its historical box scores stay valid.';

-- -----------------------------------------------------------------------------
-- players
-- -----------------------------------------------------------------------------
create table players (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete set null,
  provider_id text not null,
  external_id text not null,
  name        text not null,
  position    text,
  birth_date  date,
  nationality text,
  shirt_number smallint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (provider_id, external_id)
);

create trigger players_set_updated_at
  before update on players
  for each row execute function set_updated_at();

create index players_team_idx on players (team_id);

-- -----------------------------------------------------------------------------
-- games
-- -----------------------------------------------------------------------------
create table games (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references leagues(id) on delete cascade,
  season_id    uuid references seasons(id) on delete set null,
  provider_id  text not null,
  external_id  text not null,
  kickoff      timestamptz not null,
  status       game_status not null default 'scheduled',
  home_team_id uuid not null references teams(id) on delete restrict,
  away_team_id uuid not null references teams(id) on delete restrict,
  home_score   smallint,
  away_score   smallint,
  matchday     smallint,
  venue        text,
  attendance   integer,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider_id, external_id),
  constraint games_distinct_teams check (home_team_id <> away_team_id),
  -- A finished game must have a score; an unplayed one must not pretend to.
  constraint games_finished_has_score check (
    status <> 'finished' or (home_score is not null and away_score is not null)
  )
);

create trigger games_set_updated_at
  before update on games
  for each row execute function set_updated_at();

create index games_league_kickoff_idx on games (league_id, kickoff desc);
create index games_home_team_idx on games (home_team_id, kickoff desc);
create index games_away_team_idx on games (away_team_id, kickoff desc);

-- The fixture poller and the prediction scheduler both ask "what is coming
-- up / in flight". A partial index keeps that scan off the entire history.
create index games_upcoming_idx on games (kickoff)
  where status in ('scheduled', 'live');

comment on constraint games_finished_has_score on games is
  'A finished game without a score would silently settle predictions against NULL. Fail the ingest instead.';
comment on column games.home_team_id is
  'ON DELETE RESTRICT: deleting a team that has played games is a data-integrity bug, not a routine operation.';

-- -----------------------------------------------------------------------------
-- team_season_stats
-- -----------------------------------------------------------------------------
create table team_season_stats (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references teams(id) on delete cascade,
  season_id      uuid not null references seasons(id) on delete cascade,
  played         smallint not null default 0,
  won            smallint not null default 0,
  drawn          smallint not null default 0,
  lost           smallint not null default 0,
  goals_for      smallint not null default 0,
  goals_against  smallint not null default 0,
  points         smallint not null default 0,
  table_position smallint,
  xg_for         numeric(8, 3),
  xg_against     numeric(8, 3),
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (team_id, season_id)
);

create trigger team_season_stats_set_updated_at
  before update on team_season_stats
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- team_game_stats  — the sport-agnostic box score
-- -----------------------------------------------------------------------------
create table team_game_stats (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references games(id) on delete cascade,
  team_id          uuid not null references teams(id) on delete cascade,
  is_home          boolean not null,
  scored           smallint not null,
  conceded         smallint not null,
  result           game_result not null,
  shots            smallint,
  shots_on_target  smallint,
  possession       numeric(5, 2) check (possession is null or (possession >= 0 and possession <= 100)),
  xg_for           numeric(6, 3),
  xg_against       numeric(6, 3),
  -- Sport-specific extras (corners, turnovers, faceoff %) live here so adding a
  -- sport does not add columns. Constrained to a flat object of numbers by
  -- convention in the repository layer.
  extra            jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  created_at       timestamptz not null default now(),
  unique (game_id, team_id)
);

create index team_game_stats_team_idx on team_game_stats (team_id);

comment on table team_game_stats is
  'Mirrors TeamGameStats in src/providers/types.ts. This is the single input to Elo, Form Score and Team Strength; if a number is not here, no model may use it.';
comment on column team_game_stats.xg_for is
  'Expected goals. Nullable, and models must abstain from the performance-vs-expected term when it is NULL rather than substituting actual goals — that substitution is exactly how "recent results with extra steps" gets mistaken for form.';

-- -----------------------------------------------------------------------------
-- player_game_stats
-- -----------------------------------------------------------------------------
create table player_game_stats (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  team_id     uuid not null references teams(id) on delete cascade,
  minutes     smallint check (minutes is null or minutes >= 0),
  started     boolean,
  goals       smallint,
  assists     smallint,
  shots       smallint,
  rating      numeric(4, 2),
  extra       jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  created_at  timestamptz not null default now(),
  unique (game_id, player_id)
);

create index player_game_stats_player_idx on player_game_stats (player_id);

comment on column player_game_stats.minutes is
  'Minutes played is the shrink factor for player-absence impact: a rating recomputed on the with/without subsets is only trusted in proportion to the minutes behind it.';

-- -----------------------------------------------------------------------------
-- injuries
-- -----------------------------------------------------------------------------
create table injuries (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players(id) on delete cascade,
  team_id         uuid not null references teams(id) on delete cascade,
  status          injury_status not null,
  reason          text,
  reported_at     timestamptz not null,
  expected_return timestamptz,
  provider_id     text not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  -- Idempotent ingestion: the same report re-polled 15 minutes later collapses
  -- onto the same row instead of inflating the injury list.
  unique (player_id, provider_id, reported_at)
);

create index injuries_team_active_idx on injuries (team_id) where is_active;

comment on table injuries is
  'Availability feed. An INJURY row landing here emits a PLAYER_INJURY event, which triggers the recompute cascade in §13.';

-- -----------------------------------------------------------------------------
-- lineups
-- -----------------------------------------------------------------------------
create table lineups (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references games(id) on delete cascade,
  team_id    uuid not null references teams(id) on delete cascade,
  confirmed  boolean not null default false,
  formation  text,
  -- LineupPlayer[]: [{ playerId, playerName, position, isStarter }]
  players    jsonb not null default '[]'::jsonb check (jsonb_typeof(players) = 'array'),
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (game_id, team_id)
);

comment on column lineups.confirmed is
  'Predicted lineups and confirmed lineups are different evidence. A predicted lineup feeds the availability model at reduced weight; only a confirmed one triggers LINEUP_CHANGE.';

-- -----------------------------------------------------------------------------
-- h2h_cache
-- -----------------------------------------------------------------------------
create table h2h_cache (
  id          uuid primary key default gen_random_uuid(),
  team_a_id   uuid not null references teams(id) on delete cascade,
  team_b_id   uuid not null references teams(id) on delete cascade,
  sample_size smallint not null default 0,
  payload     jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  -- Canonical ordering by uuid so (A,B) and (B,A) cannot both exist.
  constraint h2h_cache_canonical_order check (team_a_id < team_b_id),
  unique (team_a_id, team_b_id)
);

create index h2h_cache_expiry_idx on h2h_cache (expires_at);

comment on table h2h_cache is
  'Derived head-to-head features, cached. Head-to-head is deliberately capped at a small weight and shrunk toward the prior by effective sample size: five meetings across four seasons with different squads is weak evidence (§9).';

-- -----------------------------------------------------------------------------
-- team_ratings  — strength time-series
-- -----------------------------------------------------------------------------
create table team_ratings (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete cascade,
  system        rating_system not null,
  as_of         timestamptz not null,
  rating        numeric(10, 4) not null,
  rating_deviation numeric(10, 4),
  -- For team_strength: the seven components (attack, defense, form, depth,
  -- health, home_away, momentum), each 0-100.
  components    jsonb not null default '{}'::jsonb check (jsonb_typeof(components) = 'object'),
  game_id       uuid references games(id) on delete set null,
  model_version text not null,
  created_at    timestamptz not null default now(),
  -- Re-running the rating pass over the same history is idempotent.
  unique (team_id, system, as_of, model_version)
);

create index team_ratings_lookup_idx on team_ratings (team_id, system, as_of desc);

comment on table team_ratings is
  'Point-in-time team strength. Storing the series rather than a current value is what makes point-in-time backtesting possible: the harness reads the rating as_of the prediction instant, never the rating as it is today.';
comment on column team_ratings.game_id is
  'The game whose result produced this update, when applicable. Lets the UI answer "why did this rating move?" without recomputation.';
