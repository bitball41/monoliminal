-- Remove the policy notes from the troll menu and staff ladder functions.
-- Only comment lines are removed; each function's code is unchanged.
BEGIN;
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
             AND pg_get_functiondef(p.oid) ~* '(owner policy|agents\.md|owner decision)' LOOP
    EXECUTE regexp_replace(pg_get_functiondef(f),
      E'\\n[ \\t]*--[^\\n]*(Owner policy|AGENTS\\.md|Owner decision|share the top step; never put one above|Never by role\\.)[^\\n]*', '', 'gi');
  END LOOP;
END $$;

COMMENT ON FUNCTION private.chat_troll_tier() IS NULL;

COMMIT;
