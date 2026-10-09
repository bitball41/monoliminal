BEGIN;

-- Chat tracks open connections on the private Realtime topic 'liminal-online'.
-- Only signed-in, unbanned Chat accounts may read or publish presence there;
-- other private topics and private broadcasts stay closed.
CREATE POLICY "chat_online_presence_read" ON realtime.messages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'presence'
    AND (SELECT realtime.topic()) = 'liminal-online'
    AND (SELECT private.chat_username()) IS NOT NULL
  );

CREATE POLICY "chat_online_presence_track" ON realtime.messages
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'presence'
    AND (SELECT realtime.topic()) = 'liminal-online'
    AND (SELECT private.chat_username()) IS NOT NULL
  );

COMMIT;
