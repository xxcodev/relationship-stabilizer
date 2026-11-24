-- 005: store numeric douyin user id for imported mutual-follow friends so the pure API can
-- create a conversation without re-exporting a session.
ALTER TABLE friends ADD COLUMN userid TEXT NOT NULL DEFAULT '';
