-- Games announcements and quick links share one atomic, publicly readable setting.
-- Only the existing owner/PRESTON dashboard session may publish it.
CREATE OR REPLACE FUNCTION private.games_validate_page_content(p_content jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_announcement text;
  v_link jsonb;
  v_links jsonb := '[]'::jsonb;
  v_label text;
  v_url text;
  v_description text;
BEGIN
  IF jsonb_typeof(p_content) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_content->'announcement') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_content->'links') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Games content needs an announcement and a links array';
  END IF;
  v_announcement := btrim(p_content->>'announcement');
  IF char_length(v_announcement) > 1000 THEN
    RAISE EXCEPTION 'Games announcement is too long (maximum 1000 characters)';
  END IF;
  IF jsonb_array_length(p_content->'links') > 12 THEN
    RAISE EXCEPTION 'Games supports up to 12 quick links';
  END IF;
  FOR v_link IN SELECT value FROM jsonb_array_elements(p_content->'links') LOOP
    IF jsonb_typeof(v_link) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_link->'label') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_link->'url') IS DISTINCT FROM 'string'
      OR (v_link ? 'description' AND jsonb_typeof(v_link->'description') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'Each quick link needs a text label and URL';
    END IF;
    v_label := btrim(v_link->>'label');
    v_url := btrim(v_link->>'url');
    v_description := btrim(coalesce(v_link->>'description',''));
    IF char_length(v_label) NOT BETWEEN 1 AND 60 OR char_length(v_description) > 160 THEN
      RAISE EXCEPTION 'Link labels need 1–60 characters; descriptions allow up to 160';
    END IF;
    IF char_length(v_url) > 2000 OR v_url !~ '^https?://(\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
      OR v_url ~ '[[:cntrl:]\\]' THEN
      RAISE EXCEPTION 'Quick links must use full http:// or https:// URLs without credentials or whitespace';
    END IF;
    v_links := v_links || jsonb_build_array(jsonb_build_object('label',v_label,'url',v_url,'description',v_description));
  END LOOP;
  RETURN jsonb_build_object('announcement',v_announcement,'links',v_links);
END;
$function$;
REVOKE ALL ON FUNCTION private.games_validate_page_content(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_dashboard_set_games_content(p_admin_token text, p_content jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_content jsonb;
BEGIN
  v_actor := private.require_chat_admin(p_admin_token, true);
  v_content := private.games_validate_page_content(p_content);
  INSERT INTO public.app_settings(key,value,updated_at)
  VALUES ('games_page_content',v_content::text,now())
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
  INSERT INTO private.chat_admin_audit(actor_username,action,target,details)
  VALUES(v_actor,'games_content_updated','games_page_content',jsonb_build_object(
    'announcement_length',char_length(v_content->>'announcement'),'link_count',jsonb_array_length(v_content->'links')));
  RETURN v_content;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_dashboard_set_games_content(text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_set_games_content(text,jsonb) TO authenticated;

INSERT INTO public.app_settings(key,value)
VALUES('games_page_content','{"announcement":"","links":[]}')
ON CONFLICT(key) DO NOTHING;
NOTIFY pgrst, 'reload schema';
