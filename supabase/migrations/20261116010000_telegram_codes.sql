-- One-time codes linking a wallet (proven by signature) to a Telegram chat. Private: no RLS policy.
create table telegram_codes (
  code text primary key,
  owner text not null,
  expires_at timestamptz not null
);
alter table telegram_codes enable row level security;
