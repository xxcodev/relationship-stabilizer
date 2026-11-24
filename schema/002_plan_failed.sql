-- 002: remember slots that were attempted and failed, so a restart does not retry them forever
ALTER TABLE plans ADD COLUMN failed_json TEXT NOT NULL DEFAULT '[]';
