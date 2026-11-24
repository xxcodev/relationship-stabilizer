-- 003: legacy re-imports produced duplicate event rows; make (ts, event, payload) unique
DELETE FROM events
WHERE id NOT IN (SELECT MIN(id) FROM events GROUP BY ts, event, payload);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON events(ts, event, payload);
