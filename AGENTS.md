# Working on MonoLiminal

- Fetch `origin` and compare the checkout with `origin/main` before starting a
  change. Preserve local work; do not reset it to update the repository.
- For Supabase usage investigations, read `docs/supabase-usage.md` first.
  Log Query measures diagnostic logs scanned, separately from application
  database/API traffic. Prefer saved evidence and read-only Postgres counters.
- Do not use Logs Explorer, MCP log queries, or the logs Management API as a
  polling monitor. When an investigation needs fresh logs, start with one
  explicit 5–15 minute window, filter source and relevant routes/statuses in
  the query, save the aggregate, and widen only when the evidence requires it.
  A small result limit does not establish a small scan.
- Keep database permissions, RLS, account activity definitions, media originals,
  and deployment rollback history intact when optimizing usage. Verify
  authorization and freshness alongside request reductions.
- Canonical app HTML lives in the app folders listed in `README.md`. Migrations
  live in `Backend/migrations/`. HTML publication does not apply SQL migrations.
- Run `npm test` and `node scripts/validate-deployments.mjs` for app/backend
  changes. Report local verification separately from production publication.
- `Phoenix chat/` is a friend's separate app with its own Supabase project
  (`wahnihvqlqjnlvwcybis`). The connected Supabase plugin is the WRONG database
  for Phoenix Chat: never use it for Phoenix Chat queries, migrations, or SQL.

## Troll menu access and the Phoenix rank (owner decision, Conno)

- **Phoenix (`kirk`) and Super Mega Tuff Co-owner (`PomKnee`) are equals:**
  tied on the top step of the staff ladder, under Owner and PRESTON. Don't put
  either one above or below the other; `private.chat_staff_apply_ladder`
  enforces the tie (`20261118142807_chat_phoenix_equal_to_smt.sql`).
- **Troll menu, by exact account, never by role:** full menu for `PomKnee`,
  `connor` and `kirk`, and Kirk's menu is never smaller than PomKnee's.
  The PRESTON account has the limited menu
  (`20261118142342_chat_troll_menu_preston_limited.sql`). Nobody can troll
  Kirk (troll protection), the owner or PRESTON.
- Source of truth: `private.chat_troll_tier()` and the ladder function. Change
  either only when Conno asks.
