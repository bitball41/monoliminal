-- Keep recent messages inside the bounded example budget. Relevant samples
-- come first, then recent ones; the older representative sample fills the rest.
DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.chat_noelle_claim(uuid,uuid)'::regprocedure);
  IF position('SELECT id,content,2 AS priority FROM private.noelle_ai_corpus ORDER BY md5(id::text) LIMIT 48' IN definition)=0
    OR position('SELECT id,content,3 AS priority FROM private.noelle_ai_corpus ORDER BY created_at DESC,id LIMIT 16' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected Noelle example selection; review the current claim function';
  END IF;
  definition := replace(definition,
    'SELECT id,content,2 AS priority FROM private.noelle_ai_corpus ORDER BY md5(id::text) LIMIT 48',
    'SELECT id,content,3 AS priority FROM private.noelle_ai_corpus ORDER BY md5(id::text) LIMIT 48');
  definition := replace(definition,
    'SELECT id,content,3 AS priority FROM private.noelle_ai_corpus ORDER BY created_at DESC,id LIMIT 16',
    'SELECT id,content,2 AS priority FROM private.noelle_ai_corpus ORDER BY created_at DESC,id LIMIT 16');
  EXECUTE definition;
END $$;
