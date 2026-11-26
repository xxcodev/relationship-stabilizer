-- 007: remember which video source produced a send (pool search vs default recommendation).
ALTER TABLE sends ADD COLUMN source TEXT NOT NULL DEFAULT 'pool';
