-- Parent/child hierarchy for AI-expanded video categories.
CREATE TABLE IF NOT EXISTS pool_hierarchy (
  pool_id   INTEGER PRIMARY KEY REFERENCES pools(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pool_hierarchy_parent ON pool_hierarchy(parent_id);
