# Chat analytics (removed in 6.1)

Chat analytics were removed in Chat 6.1 at the owner's request, to take work
off every message send. Apply
[`migrations/20261110222605_remove_chat_analytics.sql`](migrations/20261110222605_remove_chat_analytics.sql)
to drop:

- the `chat_analytics_message_insert`, `chat_analytics_dm_insert` and
  `chat_analytics_signup_insert` triggers;
- `chat_get_analytics`, `chat_record_activity`, `chat_analytics_summary` and
  the capture functions;
- `private.chat_message_facts`, `private.chat_activity_days`,
  `private.chat_signup_facts`, `private.chat_analytics_meta`;
- `public.messages_analytics_visible_sender_idx`.

`admin_dashboard_get_state` keeps its token check and returns settings,
moderation counts, the device registry, channels, recent messages,
deployments and the audit log, without an `analytics` key.

The browser/device moderation registry (`public.chat_devices`) is not
analytics and stays; `chat_register_device` refreshes it at each sign-in.

The earlier analytics migrations remain in `migrations/` as history.
