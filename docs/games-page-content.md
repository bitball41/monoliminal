# Games announcements and links

Open **Liminal Control → Games page** using an owner or PRESTON account.

- Write an announcement (up to 1,000 characters); blank text removes the banner.
- Add up to 12 quick links, each with a label, full HTTP/HTTPS URL, and optional description.
- Move links up/down to change their order, or remove them.
- Click **Publish Games updates** to save the banner and links together. Clearing the banner is a draft change until published.

The Games page shows these above search. Dismissal is local to the browser; changed announcement text appears again. Links open in a new tab. HTML in labels and announcements is displayed as text.

Games fetches one public settings row on load, every two minutes while visible, and when returning to the tab (at most once per minute). Slow or failed updates do not block games or erase already displayed content. Empty settings hide the entire area. No sample announcements or links are published by the migration.

Apply `Backend/migrations/20261026001714_games_page_content.sql` before deploying Games and Control. It adds the `games_page_content` setting and `admin_dashboard_set_games_content` RPC, using the existing `private.require_chat_admin(token, true)` owner authorization and settings read policy. The RPC validates all fields, writes atomically, and records an audit event. Anonymous access to the write RPC and direct writes to settings remain denied.

Checks: `node --test scripts/games-content.test.mjs scripts/games-startup.test.mjs scripts/admin-dashboard.test.mjs`; repository suite: `npm test`; deployment validation: `node scripts/validate-deployments.mjs`.
