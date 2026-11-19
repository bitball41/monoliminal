-- Name styles: four more fonts (Agrave Pro, Exile, Comic Sans, Papyrus).
-- Only the allowed font IDs change; everything else in the check is the same
-- as 20261025222612_chat_name_styles.sql.
BEGIN;
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.profiles DROP CONSTRAINT profiles_name_style_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_name_style_check CHECK (
  name_style = '{}'::jsonb OR coalesce(
    jsonb_typeof(name_style) = 'object'
    AND octet_length(name_style::text) <= 512
    AND name_style ?& ARRAY['font', 'effect', 'from', 'to', 'speed']
    AND name_style - ARRAY['font', 'effect', 'from', 'to', 'speed'] = '{}'::jsonb
    AND name_style->>'font' IN ('default', 'rounded', 'mono', 'serif', 'script', 'display',
                                'agrave', 'exile', 'comic', 'papyrus')
    AND name_style->>'effect' IN ('default', 'solid', 'gradient', 'fade', 'shift')
    AND name_style->>'from' ~ '^#[0-9a-fA-F]{6}$'
    AND name_style->>'to' ~ '^#[0-9a-fA-F]{6}$'
    AND name_style->>'speed' IN ('slow', 'normal', 'fast'), false)
);

NOTIFY pgrst, 'reload schema';
COMMIT;
