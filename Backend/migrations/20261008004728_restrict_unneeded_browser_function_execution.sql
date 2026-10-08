BEGIN;

-- Trigger functions execute through their attached table triggers, not as RPCs.
REVOKE EXECUTE ON FUNCTION
  public.chat_guard_channel_mutation(),
  public.chat_guard_message_mutation(),
  public.chat_guard_forum_mutation(),
  public.chat_guard_dm_mutation(),
  public.chat_protect_profile_privileges(),
  public.chat_enforce_message_controls(),
  public.chat_enforce_registration_control(),
  public.lc_forum_touch(),
  public.lc_ensure_following_thread()
FROM PUBLIC, anon, authenticated;

-- Deletion already verifies auth.uid(); anonymous execution serves no client.
REVOKE EXECUTE ON FUNCTION public.chat_staff_delete_account(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_staff_delete_account(text,text,text,text) TO authenticated, service_role;

COMMIT;
