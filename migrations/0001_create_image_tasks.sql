CREATE TABLE IF NOT EXISTS image_tasks (
  id TEXT PRIMARY KEY,
  uuid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  target_url TEXT NOT NULL,
  target_api_key TEXT,
  api_key_hint TEXT,
  model_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result_objects TEXT,
  result_urls TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_tasks_uuid_created_at
  ON image_tasks (uuid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_tasks_status_updated_at
  ON image_tasks (status, updated_at DESC);
