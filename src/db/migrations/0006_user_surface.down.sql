-- =============================================================================
-- 0006_user_surface (down)
-- =============================================================================

drop table if exists notifications;
drop table if exists signal_evidence;
drop table if exists signals;
drop table if exists alert_triggers;
drop table if exists alerts;
drop table if exists watchlist_items;
drop table if exists watchlists;

drop type if exists notification_status;
drop type if exists notification_channel;
drop type if exists signal_direction;
drop type if exists signal_strength;
drop type if exists alert_status;
