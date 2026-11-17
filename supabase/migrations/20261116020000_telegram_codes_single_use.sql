-- Link codes become single-use records: a code is claimed atomically (used_at), and each wallet signature can
-- create only one code (sig_hash unique), so a captured signature cannot be replayed. Rows are purged after a day.
delete from telegram_codes;
alter table telegram_codes add column sig_hash text not null unique;
alter table telegram_codes add column used_at timestamptz;
alter table telegram_codes add column created_at timestamptz not null default now();
