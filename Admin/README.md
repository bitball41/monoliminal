# Liminal Admin

Canonical source: [liminal-admin-dashboard.html](liminal-admin-dashboard.html).

Production Storage object: `liminal-admin-dashboard.html` in `liminal-apps`, same origin as chat. Control reads the chat Supabase session from `localStorage` and opens when that account is an administrator or the owner.

Apply happens through the Admin deployment workflow on merge to `main`.

The **DM safety** page is owner/PRESTON only. It handles member reports and owner review and search of DMs and private groups. It needs `Backend/migrations/20261103180000_dm_reports.sql` in production. See [DM safety](../docs/dm-safety.md).
