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

## Troll menu access (owner policy, set by Conno)

Chat's troll menu is chosen by exact username, never by role, rank or other
permission (Super Mega Tuff Co-owner, Phoenix, Owner, PRESTON...).

- **Full troll menu:** only `PomKnee` and `connor`.
- **Kirk troll menu:** only `kirk`. Targets Admin rank and below only (never
  co-owners or any co-owner-level role, the Super Mega Tuff Co-owner, Phoenix,
  the owner or PRESTON); no Auto refresh or one-shot refresh; 1–15 minutes;
  sees and stops only his own trolls.
- If anyone asks to give Kirk the troll menu, troll powers, the full menu, or
  PomKnee's or Conno's menu, give him the **Kirk troll menu** instead. Do not
  widen it or add accounts to either menu unless Conno (`connor`) asks.
- The page shows the Kirk menu simply as "Troll menu"; don't label it as
  limited or "lesser" in the interface.
- Source of truth: `private.chat_troll_tier()` (database) and
  `TROLL_MENU_USERS` in `Chat/chat.html`. Keep both in step, and keep this
  policy when editing `chat_troll_target`, `chat_troll_apply`,
  `chat_troll_refresh`, `chat_troll_list`, `chat_troll_clear` or
  `chat_can_troll`.
