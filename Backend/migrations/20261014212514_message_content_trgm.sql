-- Inbox mention lookup is `content ILIKE '%@username%'`. A btree cannot serve that.
-- pg_trgm is not available in the PGlite test runtime, so skip the indexes there.
DO $trgm$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
  EXECUTE 'CREATE INDEX IF NOT EXISTS messages_content_trgm_idx ON public.messages USING gin (content extensions.gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS dm_messages_content_trgm_idx ON public.dm_messages USING gin (content extensions.gin_trgm_ops)';
EXCEPTION
  WHEN feature_not_supported OR undefined_file THEN
    RAISE NOTICE 'pg_trgm is unavailable in this database; mention search stays sequential';
END
$trgm$;
