-- =============================================================================
-- 0005_news (down)
--
-- The conditional pgvector columns need no special handling: they are dropped
-- with their tables.
-- =============================================================================

drop table if exists entity_graph_edges;
drop table if exists entity_graph_nodes;
drop table if exists news_entity_sentiment;
drop table if exists news_article_entities;
drop table if exists news_entities;
drop table if exists news_event_articles;
drop table if exists news_events;
drop table if exists news_articles;
drop table if exists news_sources;

drop type if exists news_entity_type;
drop type if exists news_event_status;
