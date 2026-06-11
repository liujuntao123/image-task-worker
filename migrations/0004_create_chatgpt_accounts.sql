CREATE TABLE IF NOT EXISTS chatgpt_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT,
  access_token TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'invalid', 'rate_limited')),
  quota_remaining INTEGER,
  quota_limit INTEGER,
  last_checked_at TEXT,
  last_used_at TEXT,
  last_error TEXT,
  total_uses INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_accounts_status_last_used
  ON chatgpt_accounts (status, last_used_at);

CREATE INDEX IF NOT EXISTS idx_chatgpt_accounts_email
  ON chatgpt_accounts (email);

ALTER TABLE image_tasks ADD COLUMN account_id TEXT;
