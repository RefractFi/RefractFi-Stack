-- The engine was redeployed with R0 caps (2026-11-16). Keep the v1 engine's index in archive_v1, then reset the
-- live tables so the indexer rebuilds from the new engine's deploy block.
create schema if not exists archive_v1;
revoke all on schema archive_v1 from anon, authenticated;
create table archive_v1.events as table public.events;
create table archive_v1.markets as table public.markets;
create table archive_v1.crystals as table public.crystals;
create table archive_v1.beams as table public.beams;
create table archive_v1.fills as table public.fills;
create table archive_v1.windows as table public.windows;
create table archive_v1.beam_eq as table public.beam_eq;
create table archive_v1.lens_nav as table public.lens_nav;
create table archive_v1.lp_positions as table public.lp_positions;
truncate public.events, public.markets, public.beams, public.crystals, public.fills, public.windows,
  public.beam_eq, public.lens_nav, public.lp_positions, public.indexer_state;
