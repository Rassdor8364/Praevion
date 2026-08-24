-- =============================================================================
-- 0004_crypto (down)
--
-- Dropping the partitioned parent would take the partitions with it; they are
-- listed explicitly so that a hand-run down migration on a database with extra
-- (cron-created) partitions fails loudly on the parent rather than silently
-- destroying months of history nobody remembered were there.
-- =============================================================================

drop table if exists crypto_derivatives;
drop table if exists crypto_onchain_metrics;
drop table if exists crypto_orderbook_snapshots;
drop table if exists crypto_indicators;

drop table if exists crypto_candles_default;
drop table if exists crypto_candles_2026_09;
drop table if exists crypto_candles_2026_08;
drop table if exists crypto_candles_2026_07;
drop table if exists crypto_candles;

drop table if exists crypto_prices;
drop table if exists crypto_assets;
drop table if exists assets;

drop type if exists asset_class;
drop type if exists candle_interval;
