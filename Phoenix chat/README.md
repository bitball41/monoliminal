# Phoenix Chat

Phoenix Chat is a friend's app. It is **not** part of the Liminal / Corazon
ecosystem; this repository only stores its files.

- `PhoenixChat.html`: the app.
- `SQL/`: SQL for Phoenix Chat's own database.

## ⚠️ Database warning

**The Supabase plugin connected to Claude is the WRONG database for Phoenix Chat.**
That connector points at the MonoLiminal / Corazon projects. Do not use it to
inspect, migrate, or query anything for Phoenix Chat, and do not apply anything
in `SQL/` through it.

Phoenix Chat uses its own Supabase project:

| | |
| --- | --- |
| Project URL | `https://wahnihvqlqjnlvwcybis.supabase.co` |
| Project ref | `wahnihvqlqjnlvwcybis` |

MonoLiminal's projects (`trsirhyucncmyyfyiuje`, `ucgjwrjqmexenmrpbdkh`) are
unrelated to Phoenix Chat.

Phoenix Chat is not wired into MonoLiminal's deployment workflows,
`config/deployments.json`, or `Backend/migrations/`.
