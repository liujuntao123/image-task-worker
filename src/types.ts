export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
export type ImageTaskSource = "target-api" | "chatgpt-web";
export type ChatGptAccountStatus = "active" | "inactive" | "invalid" | "rate_limited";

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  IMAGE_TASK_QUEUE: Queue<ImageTaskMessage>;
  MAX_ATTEMPTS?: string;
  DEFAULT_IMAGE_TIMEOUT_SECONDS?: string;
  IMAGE_DOWNLOAD_TIMEOUT_SECONDS?: string;
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_BASE_URL?: string;
  CHATGPT_CLIENT_VERSION?: string;
  CHATGPT_CLIENT_BUILD_NUMBER?: string;
  R2_PUBLIC_BASE_URL?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  IMAGE_API_URL?: string;
  IMAGE_API_KEY?: string;
  IMAGE_API_MODEL?: string;
  IMAGE_TASK_SOURCE?: string;
}

export interface ImageTaskMessage {
  taskId: string;
}

export interface CreateTaskRequest {
  url?: string;
  key?: string;
  modelid?: string;
  targetUrl?: string;
  apiKey?: string;
  modelId?: string;
  prompt?: string;
  payload?: unknown;
  inputImages?: unknown;
  mask?: unknown;
  uuid?: string;
  maxAttempts?: number;
  source?: string;
  accountId?: string;
}

export interface AuthContext {
  userId: string;
}

export interface NormalizedCreateTaskRequest {
  targetUrl: string;
  apiKey: string | null;
  accountId: string | null;
  modelId: string;
  prompt: string;
  targetPayload: string;
  inputImages: NormalizedInputImage[];
  mask: NormalizedInputImage | null;
  uuid: string;
  maxAttempts: number;
  source: ImageTaskSource;
}

export interface ImageTaskRow {
  id: string;
  uuid: string;
  status: TaskStatus;
  target_url: string;
  target_api_key: string | null;
  api_key_hint: string | null;
  account_id?: string | null;
  model_id: string;
  prompt: string;
  target_payload: string | null;
  result_objects: string | null;
  result_urls: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  deleted_at: string | null;
  updated_at: string;
}

export interface ChatGptAccountRow {
  id: string;
  label: string;
  email: string | null;
  access_token: string;
  token_hint: string;
  status: ChatGptAccountStatus;
  quota_remaining: number | null;
  quota_limit: number | null;
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  total_uses: number;
  success_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AccountPoolListResult {
  results?: ChatGptAccountRow[];
}

export interface AccountPoolWriteRequest {
  label?: unknown;
  email?: unknown;
  accessToken?: unknown;
  token?: unknown;
  status?: unknown;
  quotaRemaining?: unknown;
  quotaLimit?: unknown;
}

export interface StoredImageObject {
  key: string;
  contentType: string;
  size: number;
}

export interface DeletedTaskCleanupTarget {
  taskId: string;
  uuid: string;
  resultObjects: string | null;
  targetPayload: string | null;
  deletedAt: string;
}

export interface NormalizedImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface NormalizedInputImage {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface StoredInputImageObject {
  key: string;
  contentType: string;
  size: number;
  filename: string;
}
