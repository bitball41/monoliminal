-- Cosmetic display-name styling. Existing profile reads and Realtime carry it;
-- no polling or per-message lookups are added.
BEGIN;

ALTER TABLE public.profiles ADD COLUMN name_style jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_name_style_check CHECK (
  name_style = '{}'::jsonb OR coalesce(
    jsonb_typeof(name_style) = 'object'
    AND octet_length(name_style::text) <= 512
    AND name_style ?& ARRAY['font', 'effect', 'from', 'to', 'speed']
    AND name_style - ARRAY['font', 'effect', 'from', 'to', 'speed'] = '{}'::jsonb
    AND name_style->>'font' IN ('default', 'rounded', 'mono', 'serif', 'script', 'display')
    AND name_style->>'effect' IN ('default', 'solid', 'gradient', 'fade', 'shift')
    AND name_style->>'from' ~ '^#[0-9a-fA-F]{6}$'
    AND name_style->>'to' ~ '^#[0-9a-fA-F]{6}$'
    AND name_style->>'speed' IN ('slow', 'normal', 'fast'), false)
);

-- Older deployments have permissive profile UPDATE policies. Restrict this
-- new cosmetic field independently without changing existing profile behavior.
CREATE FUNCTION private.chat_guard_name_style()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND NEW.name_style IS DISTINCT FROM OLD.name_style
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM OLD.user_id
          OR coalesce(OLD.is_banned, false)) THEN
    RAISE EXCEPTION 'You can only change your own name style' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.chat_guard_name_style() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER chat_guard_name_style BEFORE UPDATE OF name_style ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.chat_guard_name_style();

COMMENT ON COLUMN public.profiles.name_style IS
  'Cosmetic font/effect IDs, two six-digit colors and speed; never authorization data or arbitrary CSS.';
NOTIFY pgrst, 'reload schema';
COMMIT;
