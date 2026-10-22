-- Both owner-preview triggers compare a JSON/text ID with id::text. Keep that
-- comparison (including malformed IDs) and index only the protected subset.
SET lock_timeout = '2s';
CREATE INDEX IF NOT EXISTS messages_owner_preview_id_text_idx
  ON public.messages ((id::text)) WHERE owner_preview;
