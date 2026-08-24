-- =============================================================================
-- 0003_sports (down)
-- =============================================================================

drop table if exists team_ratings;
drop table if exists h2h_cache;
drop table if exists lineups;
drop table if exists injuries;
drop table if exists player_game_stats;
drop table if exists team_game_stats;
drop table if exists team_season_stats;
drop table if exists games;
drop table if exists players;
drop table if exists teams;
drop table if exists seasons;
drop table if exists leagues;
drop table if exists sports;

drop type if exists rating_system;
drop type if exists game_result;
drop type if exists injury_status;
drop type if exists game_status;
