-- M9: Spectrum rankings (from on-chain beam records only) and Gym paper seasons.

alter table spectrum
  add column beams int not null default 0,
  add column total_budget numeric(78,0) not null default 0,
  add column total_pnl numeric not null default 0,       -- WAD, signed
  add column max_dd_bps int not null default 0,
  add column paper_seasons int not null default 0,
  add column promoted boolean not null default false;

-- A paper season: agents trade a paper beam through the same gate as the engine, on live testnet marks.
create table gym_seasons (
  id bigserial primary key,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'finished'))
);

-- One paper beam per agent per season. Amounts are WAD strings in numeric(78,0) / numeric (signed).
create table gym_entries (
  season bigint not null references gym_seasons (id),
  agent text not null,
  budget numeric(78,0) not null,
  lev_cap numeric(78,0) not null,
  soft_bps int not null default 500,
  hard_bps int not null default 750,
  state text not null default 'Active' check (state in ('Active', 'Halved', 'Cut')),
  realized numeric not null default 0,
  hwm numeric not null,
  equity numeric not null,
  positions jsonb not null default '{}',   -- { "<market>": { "size": "<wad>", "entry": "<wad>" } }
  fills int not null default 0,
  joined_at timestamptz not null default now(),
  finished boolean not null default false,
  promoted boolean not null default false,
  primary key (season, agent)
);

-- Every paper order, keyed by its signature hash so a signed order can't be replayed.
create table gym_orders (
  sig_hash text primary key,
  season bigint not null,
  agent text not null,
  market int not null,
  size numeric not null,
  price numeric(78,0),
  fee numeric(78,0),
  result text not null,                      -- 'filled' or the gate's refusal reason
  ts timestamptz not null default now()
);

alter table gym_seasons enable row level security;
alter table gym_entries enable row level security;
alter table gym_orders enable row level security;
create policy "public read" on gym_seasons for select to anon, authenticated using (true);
create policy "public read" on gym_entries for select to anon, authenticated using (true);
create policy "public read" on gym_orders for select to anon, authenticated using (true);
