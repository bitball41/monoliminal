-- blob: links exist only inside one browser tab. Opening a QuoteBot card in the
-- lightbox and saving it as a sticker stored such a link, so the sticker (and
-- messages sending it) showed a broken image for everyone else, and for the
-- saver after a reload. Remove those unrecoverable rows and reject local links
-- at the database so an older cached client cannot store them again.

-- The images behind these links were never uploaded; nothing can restore them.
DELETE FROM public.public_stickers WHERE url ~* '^blob:';

-- Hide messages that sent one of those stickers. Soft delete keeps the
-- moderation copy, like any other deletion.
SELECT set_config('app.chat_admin_delete', 'true', true);
UPDATE public.messages SET deleted = true WHERE media_url ~* '^blob:' AND NOT coalesce(deleted, false);
UPDATE public.dm_messages SET deleted = true WHERE media_url ~* '^blob:' AND NOT coalesce(deleted, false);
SELECT set_config('app.chat_admin_delete', 'false', true);

-- Stickers are hosted files (or the small inline data: images the upload
-- fallback already stores).
ALTER TABLE public.public_stickers ADD CONSTRAINT public_stickers_url_hosted
  CHECK (url ~* '^(https://|data:image/)');
-- NOT VALID: checks new and edited rows without scanning message history.
ALTER TABLE public.messages ADD CONSTRAINT messages_media_url_not_local
  CHECK (coalesce(media_url, '') !~* '^blob:') NOT VALID;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_media_url_not_local
  CHECK (coalesce(media_url, '') !~* '^blob:') NOT VALID;
