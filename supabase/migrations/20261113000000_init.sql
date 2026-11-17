-- RefractFi testnet index. Written only by the Railway worker (secret key, bypasses RLS).
-- WAD / USDG amounts are stored as raw integers in numeric(78,0); addresses are lowercase hex text.
-- No TimescaleDB on Supabase PG17: beam_eq / lens_nav are plain tables with time indexes.

create table indexer_state (
  id text primary key,
  last_block bigint not null,
  updated_at timestamptz not null default now()
);

-- Every engine / registry / trace-roots event, raw. Activity feeds and alerts read from here.
create table events (
  tx_hash text not null,
  log_index int not null,
  block_number bigint not null,
  block_time timestamptz not null,
  contract text not null,
  name text not null,
  crystal bigint,
  beam int,
  market int,
  args jsonb not null,
  primary key (tx_hash, log_index)
);
create index events_crystal_idx on events (crystal, block_number desc);
create index events_block_idx on events (block_number desc);

create table markets (
  id int primary key,
  feed_id text not null,
  max_lev numeric(78,0) not null,
  mmr numeric(78,0) not null,
  taker_bps int not null,
  cross_bps int not null,
  skew_scale numeric(78,0) not null,
  max_funding_day numeric(78,0) not null,
  max_skew numeric(78,0) not null,
  max_age int not null,
  skew numeric(78,0) not null default 0,
  updated_at timestamptz not null default now()
);

create table crystals (
  id bigint primary key,
  owner text not null,
  opened_at timestamptz,
  beam_count int not null default 0,
  open_mask bigint not null default 0,
  collateral numeric(78,0) not null default 0,
  net_deposits numeric(78,0) not null default 0,
  perf_paid numeric(78,0) not null default 0,
  liq_paid numeric(78,0) not null default 0,
  bad_debt numeric(78,0) not null default 0,
  pending numeric(78,0) not null default 0,
  updated_at timestamptz not null default now()
);
create index crystals_owner_idx on crystals (owner);

create table beams (
  crystal bigint not null references crystals (id),
  beam int not null,
  agent text not null,
  until timestamptz not null,
  market_mask bigint not null,
  soft_bps int not null,
  hard_bps int not null,
  perf_bps int not null,
  budget numeric(78,0) not null,
  lev_cap numeric(78,0) not null,
  state text not null check (state in ('None', 'Active', 'Halved', 'Cut')),
  open_mask bigint not null default 0,
  realized numeric(78,0) not null default 0,
  hwm numeric(78,0) not null default 0,
  fee_hwm numeric(78,0) not null default 0,
  pending numeric(78,0) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (crystal, beam)
);
create index beams_agent_idx on beams (agent);

create table fills (
  tx_hash text not null,
  log_index int not null,
  block_time timestamptz not null,
  crystal bigint not null,
  beam int not null,
  market int not null,
  size numeric(78,0) not null,
  price numeric(78,0) not null,
  fee numeric(78,0) not null,
  crossed boolean not null,
  primary key (tx_hash, log_index)
);
create index fills_beam_idx on fills (crystal, beam, block_time desc);

-- A voided window is recorded with mark = 0 (the engine emits WindowSettled with zeros on void).
create table windows (
  market int not null,
  "window" bigint not null,
  matched numeric(78,0) not null,
  residual numeric(78,0) not null,
  residual_filled boolean not null,
  mark numeric(78,0) not null,
  voided boolean not null,
  settled_tx text not null,
  block_time timestamptz not null,
  primary key (market, "window")
);

create table beam_eq (
  crystal bigint not null,
  beam int not null,
  ts timestamptz not null,
  equity numeric(78,0) not null,
  hwm numeric(78,0) not null,
  state text not null,
  primary key (crystal, beam, ts)
);

create table lens_nav (
  ts timestamptz primary key,
  nav numeric(78,0) not null,
  cash numeric(78,0) not null,
  reserve numeric(78,0) not null,
  total_shares numeric(78,0) not null,
  skew jsonb not null
);

create table lp_positions (
  lp text primary key,
  shares numeric(78,0) not null,
  updated_at timestamptz not null default now()
);

create table spectrum (
  agent text primary key,
  perf_bps int not null,
  uri text not null,
  active boolean not null,
  listed_at timestamptz,
  bond numeric(78,0), -- $RFCT ranking bond: planned, unused on testnet
  rank_score numeric,
  record_from_ts timestamptz,
  updated_at timestamptz not null default now()
);

create table roots (
  epoch bigint primary key,
  root text not null,
  leaves int not null,
  tx_hash text not null,
  block_time timestamptz not null
);

-- Agent decision traces (M5). Private: the leaf hash is public via roots; the JSON is served deliberately.
create table traces (
  leaf text primary key,
  epoch bigint,
  crystal bigint not null,
  beam int not null,
  agent text not null,
  trace_json jsonb not null,
  created_at timestamptz not null default now()
);

create table alerts (
  id bigserial primary key,
  owner text not null,
  crystal bigint,
  beam int,
  kind text not null,
  payload jsonb not null default '{}',
  ts timestamptz not null default now(),
  sent_tg boolean not null default false
);
create index alerts_owner_idx on alerts (owner, ts desc);

-- Private: maps a wallet to a Telegram chat.
create table telegram_links (
  owner text primary key,
  chat_id bigint not null,
  linked_at timestamptz not null default now()
);

-- RLS on everything. Public read for on-chain-derived data; traces and telegram_links have no policies,
-- so only the worker (secret key) can touch them.
do $$
declare t text;
begin
  foreach t in array array['indexer_state','events','markets','crystals','beams','fills','windows','beam_eq',
                           'lens_nav','lp_positions','spectrum','roots','traces','alerts','telegram_links'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['indexer_state','events','markets','crystals','beams','fills','windows','beam_eq',
                           'lens_nav','lp_positions','spectrum','roots','alerts'] loop
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- Live updates for the dashboard.
alter publication supabase_realtime add table events, crystals, beams, alerts, lens_nav;
