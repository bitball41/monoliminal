# Phoenix Chat SQL

SQL for Phoenix Chat's database (`wahnihvqlqjnlvwcybis.supabase.co`).

**Do not run these files through the Supabase plugin connected to Claude — it
is the WRONG database for Phoenix Chat.** Apply them in Phoenix Chat's own
Supabase project (its SQL editor or CLI). See [`../README.md`](../README.md).

## How to run a file

1. Open the Phoenix Chat project in Supabase.
2. Go to **SQL Editor** → **New query**.
3. Paste the whole file and press **Run**.

Each file is safe to run more than once.

## Files

| File | What it does | Status |
| --- | --- | --- |
| [`2026-11-19-clear-timeouts.sql`](2026-11-19-clear-timeouts.sql) | Records who gave each timeout and their rank; staff can clear a timeout only if whoever gave it was the same rank as them or lower; adds `phoenix_timeout_status` and `phoenix_active_timeouts` for the profile popup and the staff Members tab. | Not yet confirmed as run |
