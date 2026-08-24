-- =============================================================================
-- 0008_prediction_markets (down)
--
-- Reverse order of creation: children before parents, then the enum types.
-- Policies and triggers drop with their tables. The reliability_class and
-- data_mode enums belong to 0001 and are not touched here.
-- =============================================================================

drop table if exists paper_positions;
drop table if exists paper_portfolios;
drop table if exists trader_specializations;
drop table if exists trader_metrics;
drop table if exists trader_positions;
drop table if exists trader_trades;
drop table if exists trader_accounts;
drop table if exists traders;
drop table if exists opportunities;
drop table if exists market_links;
drop table if exists prediction_market_orderbooks;
drop table if exists prediction_market_prices;
drop table if exists prediction_market_outcomes;
drop table if exists prediction_markets;
drop table if exists prediction_market_providers;

drop type if exists resolution_risk_level;
drop type if exists liquidity_grade;
drop type if exists market_status;
drop type if exists market_category;
