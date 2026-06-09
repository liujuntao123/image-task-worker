type TaskStatus = "queued" | "running" | "succeeded" | "failed";

interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  IMAGE_TASK_QUEUE: Queue<ImageTaskMessage>;
  MAX_ATTEMPTS?: string;
  DEFAULT_IMAGE_TIMEOUT_SECONDS?: string;
  IMAGE_DOWNLOAD_TIMEOUT_SECONDS?: string;
  R2_PUBLIC_BASE_URL?: string;
}

interface ImageTaskMessage {
  taskId: string;
}

interface CreateTaskRequest {
  url?: string;
  key?: string;
  modelid?: string;
  targetUrl?: string;
  apiKey?: string;
  modelId?: string;
  prompt?: string;
  payload?: unknown;
  uuid?: string;
  maxAttempts?: number;
}

interface NormalizedCreateTaskRequest {
  targetUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  targetPayload: string;
  uuid: string;
  maxAttempts: number;
}

interface ImageTaskRow {
  id: string;
  uuid: string;
  status: TaskStatus;
  target_url: string;
  target_api_key: string | null;
  api_key_hint: string | null;
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
  updated_at: string;
}

interface StoredImageObject {
  key: string;
  contentType: string;
  size: number;
}

interface NormalizedImage {
  bytes: Uint8Array;
  contentType: string;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8"
};

const MAX_TARGET_PAYLOAD_BYTES = 256 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async queue(batch: MessageBatch<ImageTaskMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await handleQueueMessage(message, env);
    }
  }
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/tasks") {
      return createTask(request, env);
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      return listTasks(url, env);
    }

    const imageMatch = url.pathname.match(/^\/tasks\/([^/]+)\/images\/(\d+)$/);
    if (request.method === "GET" && imageMatch) {
      return getTaskImage(imageMatch[1], Number(imageMatch[2]), url, env);
    }

    const detailMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (request.method === "GET" && detailMatch) {
      return getTaskDetail(detailMatch[1], url, env);
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: "internal_error", message: errorMessage(error) }, 500);
  }
}

async function createTask(request: Request, env: Env): Promise<Response> {
  const payload = validateCreateTask(await readJson<CreateTaskRequest>(request), env);
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO image_tasks (
      id, uuid, status, target_url, target_api_key, api_key_hint, model_id,
      prompt, target_payload, attempts, max_attempts, created_at, queued_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `)
    .bind(
      taskId,
      payload.uuid,
      payload.targetUrl,
      payload.apiKey,
      keyHint(payload.apiKey),
      payload.modelId,
      payload.prompt,
      payload.targetPayload,
      payload.maxAttempts,
      now,
      now,
      now
    )
    .run();

  try {
    await env.IMAGE_TASK_QUEUE.send({ taskId });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE image_tasks
      SET status = 'failed',
          target_api_key = NULL,
          error = ?,
          failed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
      .bind(`queue_send_error:${truncate(errorMessage(error), 1000)}`, failedAt, failedAt, taskId)
      .run();

    throw error;
  }

  return json(
    {
      taskId,
      uuid: payload.uuid,
      status: "queued",
      createdAt: now
    },
    202
  );
}

async function listTasks(url: URL, env: Env): Promise<Response> {
  const uuids = parseUuidQuery(url);
  if (uuids.length === 0) {
    return json({ error: "uuid_required" }, 400);
  }

  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 100);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 100000);
  const placeholders = uuids.map(() => "?").join(", ");
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM image_tasks
    WHERE uuid IN (${placeholders})
  `)
    .bind(...uuids)
    .first<{ count: number }>();

  const result = await env.DB.prepare(`
    SELECT * FROM image_tasks
    WHERE uuid IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(...uuids, limit, offset)
    .all<ImageTaskRow>();

  return json({
    tasks: (result.results ?? []).map(serializeTask),
    pagination: {
      limit,
      offset,
      total: countResult?.count ?? 0,
      nextOffset: offset + (result.results ?? []).length < (countResult?.count ?? 0) ? offset + limit : null
    }
  });
}

async function getTaskDetail(taskId: string, url: URL, env: Env): Promise<Response> {
  const row = await selectTask(taskId, env);
  if (!row || !matchesUuidFilter(row, url)) {
    return json({ error: "task_not_found" }, 404);
  }

  return json({ task: serializeTask(row) });
}

async function getTaskImage(taskId: string, imageIndex: number, url: URL, env: Env): Promise<Response> {
  const row = await selectTask(taskId, env);
  if (!row || !matchesUuidFilter(row, url)) {
    return json({ error: "task_not_found" }, 404);
  }

  const objects = parseJsonArray<StoredImageObject>(row.result_objects);
  const object = objects[imageIndex];
  if (!object) {
    return json({ error: "image_not_found" }, 404);
  }

  const r2Object = await env.IMAGES.get(object.key);
  if (!r2Object) {
    return json({ error: "image_object_missing" }, 404);
  }

  const headers = new Headers();
  r2Object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") ?? object.contentType);
  headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=31536000");
  headers.set("ETag", r2Object.httpEtag);

  return withCors(new Response(r2Object.body, { headers }));
}

async function handleQueueMessage(message: Message<ImageTaskMessage>, env: Env): Promise<void> {
  const taskId = message.body?.taskId;
  if (!taskId) {
    message.ack();
    return;
  }

  const task = await selectTask(taskId, env);
  if (!task || task.status === "succeeded" || task.status === "failed") {
    logTaskEvent("image_task_skip", {
      taskId,
      reason: !task ? "not_found" : `already_${task.status}`
    });
    message.ack();
    return;
  }

  const attempt = task.attempts + 1;
  const now = new Date().toISOString();
  const startedAtMs = Date.now();
  logTaskEvent("image_task_start", {
    taskId,
    uuid: task.uuid,
    status: task.status,
    attempt,
    maxAttempts: task.max_attempts,
    targetUrl: task.target_url,
    modelId: task.model_id,
    promptLength: task.prompt.length,
    targetPayloadBytes: byteLength(task.target_payload ?? ""),
    queuedAt: task.queued_at,
    startedAt: now
  });

  await env.DB.prepare(`
    UPDATE image_tasks
    SET status = 'running',
        attempts = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?,
        error = NULL
    WHERE id = ?
  `)
    .bind(attempt, now, now, taskId)
    .run();

  try {
    const images = await callTargetImageApi(task, env);
    const storedObjects = await storeImages(task, images, env);
    const resultUrls = resultUrlsFor(task, storedObjects, env);
    const completedAt = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE image_tasks
      SET status = 'succeeded',
          target_api_key = NULL,
          result_objects = ?,
          result_urls = ?,
          completed_at = ?,
          updated_at = ?,
          error = NULL
      WHERE id = ?
    `)
      .bind(JSON.stringify(storedObjects), JSON.stringify(resultUrls), completedAt, completedAt, taskId)
      .run();

    logTaskEvent("image_task_success", {
      taskId,
      uuid: task.uuid,
      attempt,
      maxAttempts: task.max_attempts,
      imageCount: storedObjects.length,
      resultBytes: storedObjects.reduce((sum, object) => sum + object.size, 0),
      resultObjects: storedObjects.map((object) => ({
        key: object.key,
        contentType: object.contentType,
        size: object.size
      })),
      startedAt: now,
      completedAt,
      durationMs: Date.now() - startedAtMs
    });

    message.ack();
  } catch (error) {
    const latest = await selectTask(taskId, env);
    const maxAttempts = latest?.max_attempts ?? task.max_attempts;
    const errorText = truncate(errorMessage(error), 2000);

    if (attempt < maxAttempts) {
      const queuedAt = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE image_tasks
        SET status = 'queued',
            error = ?,
            queued_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .bind(errorText, queuedAt, queuedAt, taskId)
        .run();

      logTaskEvent("image_task_retry", {
        taskId,
        uuid: task.uuid,
        attempt,
        maxAttempts,
        error: errorText,
        startedAt: now,
        queuedAt,
        durationMs: Date.now() - startedAtMs,
        delaySeconds: retryDelaySeconds(attempt)
      });

      message.retry({ delaySeconds: retryDelaySeconds(attempt) });
      return;
    }

    const failedAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE image_tasks
      SET status = 'failed',
          target_api_key = NULL,
          error = ?,
          failed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
      .bind(errorText, failedAt, failedAt, taskId)
      .run();

    logTaskEvent("image_task_failure", {
      taskId,
      uuid: task.uuid,
      attempt,
      maxAttempts,
      error: errorText,
      startedAt: now,
      failedAt,
      durationMs: Date.now() - startedAtMs
    });

    message.ack();
  }
}

async function callTargetImageApi(task: ImageTaskRow, env: Env): Promise<NormalizedImage[]> {
  if (!task.target_api_key) {
    throw new Error("target_api_key_missing");
  }

  const timeoutMs = parseBoundedInteger(env.DEFAULT_IMAGE_TIMEOUT_SECONDS, 600, 10, 900) * 1000;
  const response = await fetchWithTimeout(
    task.target_url,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${task.target_api_key}`,
        "Content-Type": "application/json"
      },
      body: targetRequestBodyForTask(task)
    },
    timeoutMs
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`target_api_error:${response.status}:${truncate(body, 1000)}`);
  }

  return parseImageApiResponse(response, env);
}

export function targetRequestBodyForTask(task: Pick<ImageTaskRow, "target_payload" | "model_id" | "prompt">): string {
  return task.target_payload || JSON.stringify({ model: task.model_id, prompt: task.prompt });
}

export async function parseImageApiResponse(response: Response, env?: Env): Promise<NormalizedImage[]> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("image/")) {
    return [
      {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: normalizeImageContentType(contentType)
      }
    ];
  }

  const jsonBody = (await response.json()) as unknown;
  const refs = extractImageReferences(jsonBody);
  if (refs.length === 0) {
    throw new Error("target_response_missing_image");
  }

  const images: NormalizedImage[] = [];
  for (const ref of refs) {
    images.push(await imageFromReference(ref, env));
  }
  return images;
}

export function extractImageReferences(value: unknown): string[] {
  const refs: string[] = [];

  if (typeof value === "string") {
    if (looksLikeImageReference(value)) refs.push(value);
    return refs;
  }

  if (!value || typeof value !== "object") {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) refs.push(...extractImageReferences(item));
    return refs;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["b64_json", "url", "image_url", "image", "output"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && looksLikeImageReference(candidate)) {
      refs.push(candidate);
    }
  }

  for (const key of ["data", "images", "output", "result"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      refs.push(...extractImageReferences(nested));
    }
  }

  return Array.from(new Set(refs));
}

async function imageFromReference(ref: string, env?: Env): Promise<NormalizedImage> {
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    const timeoutMs = parseBoundedInteger(env?.IMAGE_DOWNLOAD_TIMEOUT_SECONDS, 120, 10, 900) * 1000;
    const imageResponse = await fetchWithTimeout(ref, {}, timeoutMs);
    if (!imageResponse.ok) {
      throw new Error(`image_download_error:${imageResponse.status}`);
    }

    const contentType = normalizeImageContentType(imageResponse.headers.get("content-type") ?? "");
    return {
      bytes: new Uint8Array(await imageResponse.arrayBuffer()),
      contentType
    };
  }

  if (ref.startsWith("data:")) {
    const match = ref.match(/^data:([^;,]+)?;base64,(.+)$/);
    if (!match) {
      throw new Error("invalid_data_url_image");
    }

    return {
      bytes: base64ToBytes(match[2]),
      contentType: normalizeImageContentType(match[1] ?? "image/png")
    };
  }

  return {
    bytes: base64ToBytes(ref),
    contentType: "image/png"
  };
}

async function storeImages(task: ImageTaskRow, images: NormalizedImage[], env: Env): Promise<StoredImageObject[]> {
  const stored: StoredImageObject[] = [];

  for (const [index, image] of images.entries()) {
    const extension = extensionForContentType(image.contentType);
    const key = `tasks/${task.uuid}/${task.id}/${index}.${extension}`;
    await env.IMAGES.put(key, image.bytes, {
      httpMetadata: {
        contentType: image.contentType
      },
      customMetadata: {
        taskId: task.id,
        uuid: task.uuid,
        modelId: task.model_id
      }
    });

    stored.push({
      key,
      contentType: image.contentType,
      size: image.bytes.byteLength
    });
  }

  return stored;
}

function resultUrlsFor(task: ImageTaskRow, objects: StoredImageObject[], env: Env): string[] {
  const publicBaseUrl = (env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (publicBaseUrl) {
    return objects.map((object) => `${publicBaseUrl}/${object.key}`);
  }

  return objects.map((_, index) => `/tasks/${task.id}/images/${index}`);
}

async function selectTask(taskId: string, env: Env): Promise<ImageTaskRow | null> {
  return env.DB.prepare("SELECT * FROM image_tasks WHERE id = ?").bind(taskId).first<ImageTaskRow>();
}

function validateCreateTask(input: CreateTaskRequest, env: Env): NormalizedCreateTaskRequest {
  const targetUrl = stringField(input.targetUrl ?? input.url, "url", 2048);
  const apiKey = stringField(input.apiKey ?? input.key, "key", 4096);
  const explicitPayload = normalizeTargetPayload(input.payload);
  const modelId =
    optionalStringField(input.modelId ?? input.modelid, 256) ??
    optionalStringField(explicitPayload?.model, 256) ??
    (explicitPayload ? "" : stringField(undefined, "modelid", 256));
  const prompt =
    optionalStringField(input.prompt, 20000) ??
    optionalStringField(explicitPayload?.prompt, 20000) ??
    (explicitPayload ? "" : stringField(undefined, "prompt", 20000));
  const targetPayload = stringifyTargetPayload(explicitPayload ?? { model: modelId, prompt });
  const uuid = stringField(input.uuid, "uuid", 128);
  const maxAttempts = parseBoundedInteger(
    input.maxAttempts === undefined ? env.MAX_ATTEMPTS : String(input.maxAttempts),
    3,
    1,
    10
  );

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new HttpError(400, "invalid_target_url");
  }

  return {
    targetUrl,
    apiKey,
    modelId,
    prompt,
    targetPayload,
    uuid,
    maxAttempts
  };
}

function normalizeTargetPayload(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "payload_object_required");
  }

  return value as Record<string, unknown>;
}

function stringifyTargetPayload(payload: Record<string, unknown>): string {
  const jsonPayload = JSON.stringify(payload);
  if (byteLength(jsonPayload) > MAX_TARGET_PAYLOAD_BYTES) {
    throw new HttpError(400, "payload_too_large");
  }
  return jsonPayload;
}

function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${name}_required`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name}_too_long`);
  }

  return trimmed;
}

function optionalStringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    throw new HttpError(400, "field_too_long");
  }

  return trimmed;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function parseUuidQuery(url: URL): string[] {
  const rawValues = url.searchParams
    .getAll("uuid")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(rawValues)).slice(0, 25);
}

function matchesUuidFilter(row: ImageTaskRow, url: URL): boolean {
  const uuids = parseUuidQuery(url);
  return uuids.length === 0 || uuids.includes(row.uuid);
}

function serializeTask(row: ImageTaskRow) {
  return {
    id: row.id,
    uuid: row.uuid,
    status: row.status,
    targetUrl: row.target_url,
    apiKeyHint: row.api_key_hint,
    modelId: row.model_id,
    prompt: row.prompt,
    targetPayload: parseJsonObject(row.target_payload),
    resultObjects: parseJsonArray<StoredImageObject>(row.result_objects),
    resultUrls: parseJsonArray<string>(row.result_urls),
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: JSON_HEADERS
    })
  );
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function parseBoundedInteger(value: string | null | undefined, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeImageReference(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:image/") ||
    looksLikeBase64Image(value)
  );
}

function looksLikeBase64Image(value: string): boolean {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return false;
  }

  return compact.startsWith("iVBORw0KGgo") || compact.startsWith("/9j/") || compact.startsWith("UklGR");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeImageContentType(value: string): string {
  const contentType = value.split(";")[0].trim().toLowerCase();
  if (contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp") {
    return contentType;
  }
  return "image/png";
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

function keyHint(apiKey: string): string {
  return apiKey.length <= 8 ? "***" : `***${apiKey.slice(-4)}`;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 300);
}

function logTaskEvent(event: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details
    })
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
