import { sha3_512 } from "js-sha3";
import { AuthError, requireAuth } from "./auth";
import {
  byteLength,
  ensureOk,
  errorMessage,
  fetchWithTimeout,
  HttpError,
  json,
  parseBoundedInteger,
  sleep,
  truncate,
  withCors
} from "./core";
import {
  base64ToBytes,
  bytesToBase64,
  extensionForContentType,
  imageFromReference,
  normalizeImageContentType,
  parseImageApiResponse
} from "./image-codecs";
import { optionalNullableInteger, optionalStringField, readJson, stringField } from "./input-validation";
import { parseJsonArray, parseJsonObject, parseStoredInputImageObject, parseStoredInputImageObjects } from "./json-utils";
import {
  buildStoredTargetPayload,
  cleanupDeletedTaskObjects,
  cleanupModeFor,
  deleteStoredObjects,
  resultUrlsFor,
  selectTask,
  storeImages,
  storeInputImages,
  storeMaskImage
} from "./task-storage";
import { CHATGPT_WEB_SOURCE, validateCreateTask } from "./task-normalizer";
import type {
  AccountPoolListResult,
  AccountPoolWriteRequest,
  AuthContext,
  ChatGptAccountRow,
  ChatGptAccountStatus,
  DeletedTaskCleanupTarget,
  CreateTaskRequest,
  Env,
  ImageTaskMessage,
  ImageTaskRow,
  ImageTaskSource,
  NormalizedImage,
  StoredImageObject,
  StoredInputImageObject
} from "./types";
export type { Env } from "./types";
export { extractImageReferences, parseImageApiResponse } from "./image-codecs";

const ACCOUNT_POOL_PAGE_SIZE_MAX = 100;
const CHATGPT_DEFAULT_BASE_URL = "https://chatgpt.com";
const CHATGPT_DEFAULT_CLIENT_VERSION = "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887";
const CHATGPT_DEFAULT_CLIENT_BUILD_NUMBER = "6708908";
const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const CHATGPT_SEC_CH_UA = '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"';
const CHATGPT_CODEX_IMAGE_MODEL = "codex-gpt-image-2";
const CHATGPT_CODEX_RESPONSES_MODEL = "gpt-5.5";
const CHATGPT_CODEX_IMAGE_INSTRUCTIONS =
  "Use the image_generation tool to create exactly one image for the user's request. Return the generated image result.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async queue(batch: MessageBatch<ImageTaskMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await handleQueueMessage(message, env);
    }
  }
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/admin/accounts") {
      return accountAdminPage();
    }

    if (request.method === "POST" && url.pathname === "/tasks") {
      return createTask(request, env, await requireAuth(request, env));
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      return listTasks(url, env, await requireAuth(request, env));
    }

    if (request.method === "GET" && url.pathname === "/accounts") {
      return listAccounts(url, env);
    }

    if (request.method === "POST" && url.pathname === "/accounts") {
      return createAccount(request, env);
    }

    const accountCheckMatch = url.pathname.match(/^\/accounts\/([^/]+)\/check$/);
    if (request.method === "POST" && accountCheckMatch) {
      return checkAccount(accountCheckMatch[1], env);
    }

    const accountMatch = url.pathname.match(/^\/accounts\/([^/]+)$/);
    if (request.method === "GET" && accountMatch) {
      return getAccount(accountMatch[1], env);
    }

    if (request.method === "PATCH" && accountMatch) {
      return updateAccount(accountMatch[1], request, env);
    }

    if (request.method === "DELETE" && accountMatch) {
      return deleteAccount(accountMatch[1], env);
    }

    const imageMatch = url.pathname.match(/^\/tasks\/([^/]+)\/images\/(\d+)$/);
    if (request.method === "GET" && imageMatch) {
      return getTaskImage(imageMatch[1], Number(imageMatch[2]), env, await requireAuth(request, env));
    }

    const detailMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (request.method === "GET" && detailMatch) {
      return getTaskDetail(detailMatch[1], env, await requireAuth(request, env));
    }

    if (request.method === "DELETE" && detailMatch) {
      return deleteTask(detailMatch[1], env, ctx, await requireAuth(request, env));
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof HttpError || error instanceof AuthError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: "internal_error", message: errorMessage(error) }, 500);
  }
}

async function createTask(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const payload = validateCreateTask(await readJson<CreateTaskRequest>(request), env, auth);
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const inputObjects = await storeInputImages(taskId, payload.uuid, payload.inputImages, env);
  const maskObject = payload.mask ? await storeMaskImage(taskId, payload.uuid, payload.mask, env) : null;
  const targetPayload = buildStoredTargetPayload(
    payload.targetPayload,
    inputObjects,
    maskObject,
    payload.source,
    payload.accountId
  );

  await env.DB.prepare(`
    INSERT INTO image_tasks (
      id, uuid, status, target_url, target_api_key, api_key_hint, account_id, model_id,
      prompt, target_payload, attempts, max_attempts, created_at, queued_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `)
    .bind(
      taskId,
      payload.uuid,
      payload.targetUrl,
      payload.apiKey,
      payload.apiKey ? keyHint(payload.apiKey) : payload.accountId,
      payload.accountId,
      payload.modelId,
      payload.prompt,
      targetPayload,
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
      userId: payload.uuid,
      status: "queued",
      createdAt: now
    },
    202
  );
}

async function listTasks(url: URL, env: Env, auth: AuthContext): Promise<Response> {
  const ownerId = auth.userId;
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 100);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 100000);
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM image_tasks
    WHERE uuid = ?
      AND deleted_at IS NULL
  `)
    .bind(ownerId)
    .first<{ count: number }>();

  const result = await env.DB.prepare(`
    SELECT * FROM image_tasks
    WHERE uuid = ?
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(ownerId, limit, offset)
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

async function getTaskDetail(taskId: string, env: Env, auth: AuthContext): Promise<Response> {
  const row = await selectTask(taskId, env);
  if (!row || row.deleted_at || row.uuid !== auth.userId) {
    return json({ error: "task_not_found" }, 404);
  }

  return json({ task: serializeTask(row) });
}

async function getTaskImage(taskId: string, imageIndex: number, env: Env, auth: AuthContext): Promise<Response> {
  const row = await selectTask(taskId, env);
  if (!row || row.deleted_at || row.uuid !== auth.userId) {
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

async function deleteTask(taskId: string, env: Env, ctx: ExecutionContext, auth: AuthContext): Promise<Response> {
  const deletedAt = new Date().toISOString();
  const deleted = await env.DB.prepare(`
    UPDATE image_tasks
    SET target_api_key = NULL,
        target_payload = NULL,
        result_objects = NULL,
        result_urls = NULL,
        deleted_at = ?,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
      AND uuid = ?
    RETURNING id AS taskId, uuid, result_objects AS resultObjects, target_payload AS targetPayload, deleted_at AS deletedAt
  `)
    .bind(deletedAt, deletedAt, taskId, auth.userId)
    .first<DeletedTaskCleanupTarget>();

  if (!deleted) {
    return json({ error: "task_not_found" }, 404);
  }

  ctx.waitUntil(cleanupDeletedTaskObjects(deleted, env, logTaskEvent));

  logTaskEvent("image_task_deleted", {
    taskId,
    uuid: deleted.uuid,
    deletedAt,
    cleanupMode: cleanupModeFor(deleted)
  });

  return json({ deleted: true, taskId, deletedAt });
}

async function listAccounts(url: URL, env: Env): Promise<Response> {
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, ACCOUNT_POOL_PAGE_SIZE_MAX);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 100000);
  const status = normalizeAccountStatus(url.searchParams.get("status"), false);
  const search = optionalStringField(url.searchParams.get("q"), 120);
  const where: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];

  if (status) {
    where.push("status = ?");
    values.push(status);
  }
  if (search) {
    where.push("(label LIKE ? OR email LIKE ? OR token_hint LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereSql = where.join(" AND ");
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM chatgpt_accounts WHERE ${whereSql}`)
    .bind(...values)
    .first<{ count: number }>();
  const rows = await env.DB.prepare(`
    SELECT * FROM chatgpt_accounts
    WHERE ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(...values, limit, offset)
    .all<ChatGptAccountRow>();

  return json({
    accounts: (rows.results ?? []).map(serializeAccount),
    pagination: {
      limit,
      offset,
      total: count?.count ?? 0,
      nextOffset: offset + (rows.results ?? []).length < (count?.count ?? 0) ? offset + limit : null
    }
  });
}

async function getAccount(accountId: string, env: Env): Promise<Response> {
  const account = await selectAccount(accountId, env);
  if (!account) {
    return json({ error: "account_not_found" }, 404);
  }
  return json({ account: serializeAccount(account) });
}

async function createAccount(request: Request, env: Env): Promise<Response> {
  const input = await readJson<AccountPoolWriteRequest>(request);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const accessToken = stringField(input.accessToken ?? input.token, "accessToken", 4096);
  const label = optionalStringField(input.label, 120) ?? optionalStringField(input.email, 254) ?? `ChatGPT account ${id.slice(0, 8)}`;
  const email = optionalStringField(input.email, 254) ?? null;
  const status = normalizeAccountStatus(input.status, true) ?? "active";
  const quotaRemaining = optionalNullableInteger(input.quotaRemaining, 0, 1000000);
  const quotaLimit = optionalNullableInteger(input.quotaLimit, 0, 1000000);

  await env.DB.prepare(`
    INSERT INTO chatgpt_accounts (
      id, label, email, access_token, token_hint, status,
      quota_remaining, quota_limit, total_uses, success_count, failure_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `)
    .bind(id, label, email, accessToken, keyHint(accessToken), status, quotaRemaining, quotaLimit, now, now)
    .run();

  const account = await selectAccount(id, env);
  return json({ account: account ? serializeAccount(account) : { id, label, email, status, tokenHint: keyHint(accessToken) } }, 201);
}

async function updateAccount(accountId: string, request: Request, env: Env): Promise<Response> {
  const account = await selectAccount(accountId, env);
  if (!account) {
    return json({ error: "account_not_found" }, 404);
  }

  const input = await readJson<AccountPoolWriteRequest>(request);
  const accessToken = optionalStringField(input.accessToken ?? input.token, 4096);
  const label = optionalStringField(input.label, 120) ?? account.label;
  const email = input.email === null ? null : optionalStringField(input.email, 254) ?? account.email;
  const status = normalizeAccountStatus(input.status, false) ?? account.status;
  const quotaRemaining =
    input.quotaRemaining === undefined ? account.quota_remaining : optionalNullableInteger(input.quotaRemaining, 0, 1000000);
  const quotaLimit = input.quotaLimit === undefined ? account.quota_limit : optionalNullableInteger(input.quotaLimit, 0, 1000000);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE chatgpt_accounts
    SET label = ?,
        email = ?,
        access_token = COALESCE(?, access_token),
        token_hint = COALESCE(?, token_hint),
        status = ?,
        quota_remaining = ?,
        quota_limit = ?,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(label, email, accessToken ?? null, accessToken ? keyHint(accessToken) : null, status, quotaRemaining, quotaLimit, now, accountId)
    .run();

  const updated = await selectAccount(accountId, env);
  return json({ account: updated ? serializeAccount(updated) : null });
}

async function deleteAccount(accountId: string, env: Env): Promise<Response> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE chatgpt_accounts
    SET deleted_at = ?,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(now, now, accountId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ error: "account_not_found" }, 404);
  }
  return json({ deleted: true, accountId, deletedAt: now });
}

async function checkAccount(accountId: string, env: Env): Promise<Response> {
  const account = await selectAccount(accountId, env);
  if (!account) {
    return json({ error: "account_not_found" }, 404);
  }

  const now = new Date().toISOString();
  let status: ChatGptAccountStatus = "active";
  let errorText: string | null = null;
  try {
    const client = new ChatGptWebClient({
      accessToken: account.access_token,
      baseUrl: chatGptBaseUrl(env),
      clientVersion: env.CHATGPT_CLIENT_VERSION,
      clientBuildNumber: env.CHATGPT_CLIENT_BUILD_NUMBER,
      requestTimeoutMs: 30000,
      downloadTimeoutMs: 30000
    });
    await client.checkAccess();
  } catch (error) {
    errorText = truncate(errorMessage(error), 1000);
    status = accountStatusForError(errorText);
  }

  await env.DB.prepare(`
    UPDATE chatgpt_accounts
    SET status = ?,
        last_checked_at = ?,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(status, now, errorText, now, accountId)
    .run();

  const updated = await selectAccount(accountId, env);
  return json({ ok: status === "active", account: updated ? serializeAccount(updated) : null });
}

async function handleQueueMessage(message: Message<ImageTaskMessage>, env: Env): Promise<void> {
  const taskId = message.body?.taskId;
  if (!taskId) {
    message.ack();
    return;
  }

  const task = await selectTask(taskId, env);
  if (!task || task.deleted_at || task.status === "succeeded" || task.status === "failed") {
    logTaskEvent("image_task_skip", {
      taskId,
      reason: !task ? "not_found" : task.deleted_at ? "deleted" : `already_${task.status}`
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

  const runningUpdate = await env.DB.prepare(`
    UPDATE image_tasks
    SET status = 'running',
        attempts = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?,
        error = NULL
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(attempt, now, now, taskId)
    .run();

  if ((runningUpdate.meta.changes ?? 0) === 0) {
    logTaskEvent("image_task_skip", {
      taskId,
      uuid: task.uuid,
      reason: "deleted_before_start",
      attempt
    });
    message.ack();
    return;
  }

  try {
    const images = await callTargetImageApi(task, env);
    const beforeStore = await selectTask(taskId, env);
    if (!beforeStore || beforeStore.deleted_at) {
      logTaskEvent("image_task_skip_store", {
        taskId,
        uuid: task.uuid,
        reason: !beforeStore ? "not_found" : "deleted",
        durationMs: Date.now() - startedAtMs
      });
      message.ack();
      return;
    }

    const storedObjects = await storeImages(task, images, env);
    const resultUrls = resultUrlsFor(task, storedObjects, env);
    const completedAt = new Date().toISOString();

    const updateResult = await env.DB.prepare(`
      UPDATE image_tasks
      SET status = 'succeeded',
          target_api_key = NULL,
          result_objects = ?,
          result_urls = ?,
          completed_at = ?,
          updated_at = ?,
          error = NULL
      WHERE id = ?
        AND deleted_at IS NULL
    `)
      .bind(JSON.stringify(storedObjects), JSON.stringify(resultUrls), completedAt, completedAt, taskId)
      .run();

    if ((updateResult.meta.changes ?? 0) === 0) {
      await deleteStoredObjects(storedObjects, env);
      logTaskEvent("image_task_cleanup_after_delete", {
        taskId,
        uuid: task.uuid,
        cleanedObjects: storedObjects.length,
        durationMs: Date.now() - startedAtMs
      });
      message.ack();
      return;
    }

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
          AND deleted_at IS NULL
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
        AND deleted_at IS NULL
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
  const source = imageTaskSourceFor(task);
  if (source === "chatgpt-web") {
    return callChatGptWebImageSource(task, env);
  }

  if (!task.target_api_key) {
    throw new Error("target_api_key_missing");
  }

  const request = await targetRequestForTask(task, env);
  const timeoutMs = parseBoundedInteger(env.DEFAULT_IMAGE_TIMEOUT_SECONDS, 600, 10, 900) * 1000;
  const response = await fetchWithTimeout(
    request.url,
    {
      method: "POST",
      headers: request.headers,
      body: request.body
    },
    timeoutMs
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`target_api_error:${response.status}:${truncate(body, 1000)}`);
  }

  return parseImageApiResponse(response, env);
}

export async function targetRequestForTask(
  task: Pick<ImageTaskRow, "target_payload" | "target_api_key" | "target_url" | "model_id" | "prompt">,
  env: Env
): Promise<{ url: string; headers: Headers; body: BodyInit }> {
  const headers = new Headers({
    Authorization: `Bearer ${task.target_api_key ?? ""}`
  });
  const payload = parseJsonObject(task.target_payload) ?? { model: task.model_id, prompt: task.prompt };
  const inputObjects = parseStoredInputImageObjects(payload.__inputImages);
  const maskObject = parseStoredInputImageObject(payload.__maskImage);

  if (inputObjects.length === 0) {
    headers.set("Content-Type", "application/json");
    return {
      url: task.target_url,
      headers,
      body: targetRequestBodyForTask(task)
    };
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (key === "__inputImages" || key === "__maskImage" || value === undefined || value === null) continue;
    appendFormValue(formData, key, value);
  }

  for (const [index, object] of inputObjects.entries()) {
    const image = await env.IMAGES.get(object.key);
    if (!image) {
      throw new Error(`input_image_missing:${object.key}`);
    }
    const contentType = normalizeImageContentType(object.contentType);
    const blob = new Blob([await image.arrayBuffer()], { type: contentType });
    formData.append("image[]", blob, object.filename || `input-${index + 1}.${extensionForContentType(contentType)}`);
  }

  if (maskObject) {
    const mask = await env.IMAGES.get(maskObject.key);
    if (!mask) {
      throw new Error(`mask_image_missing:${maskObject.key}`);
    }
    const blob = new Blob([await mask.arrayBuffer()], { type: "image/png" });
    formData.append("mask", blob, "mask.png");
  }

  return {
    url: editUrlFor(task.target_url),
    headers,
    body: formData
  };
}

export function targetRequestBodyForTask(task: Pick<ImageTaskRow, "target_payload" | "model_id" | "prompt">): string {
  const payload = parseJsonObject(task.target_payload);
  if (!payload) return JSON.stringify({ model: task.model_id, prompt: task.prompt });
  delete payload.__inputImages;
  delete payload.__maskImage;
  delete payload.__source;
  return JSON.stringify(payload);
}

async function callChatGptWebImageSource(task: ImageTaskRow, env: Env): Promise<NormalizedImage[]> {
  const credential = await chatGptCredentialForTask(task, env);

  const payload = parseJsonObject(task.target_payload) ?? {};
  const prompt = optionalStringField(payload.prompt, 20000) ?? task.prompt;
  const model = optionalStringField(payload.model, 256) ?? task.model_id;
  const size = optionalStringField(payload.size, 64) ?? "1024x1024";
  const quality = optionalStringField(payload.quality, 64) ?? "auto";
  const inputObjects = parseStoredInputImageObjects(payload.__inputImages);
  const baseUrl = chatGptBaseUrl(env, task.target_url);
  const client = new ChatGptWebClient({
    accessToken: credential.accessToken,
    baseUrl,
    clientVersion: env.CHATGPT_CLIENT_VERSION,
    clientBuildNumber: env.CHATGPT_CLIENT_BUILD_NUMBER,
    requestTimeoutMs: parseBoundedInteger(env.DEFAULT_IMAGE_TIMEOUT_SECONDS, 600, 10, 900) * 1000,
    downloadTimeoutMs: parseBoundedInteger(env.IMAGE_DOWNLOAD_TIMEOUT_SECONDS, 120, 10, 900) * 1000
  });

  try {
    if (model === CHATGPT_CODEX_IMAGE_MODEL) {
      const inputImages = await loadInputImagesAsDataUrls(inputObjects, env);
      const imageRefs = await client.generateCodexImage(prompt, inputImages, size, quality);
      const images = await refsToImages(imageRefs, env);
      await recordAccountUseResult(credential.accountId, true, null, env);
      return images;
    }

    if (inputObjects.length > 0) {
      throw new Error("chatgpt_web_image_edit_not_supported_in_worker");
    }

    const imageUrls = await client.generateWebImage(prompt, model);
    const images = await refsToImages(imageUrls, env);
    await recordAccountUseResult(credential.accountId, true, null, env);
    return images;
  } catch (error) {
    await recordAccountUseResult(credential.accountId, false, errorMessage(error), env);
    throw error;
  }
}

async function refsToImages(refs: string[], env: Env): Promise<NormalizedImage[]> {
  if (refs.length === 0) {
    throw new Error("chatgpt_response_missing_image");
  }

  const images: NormalizedImage[] = [];
  for (const ref of refs) {
    images.push(await imageFromReference(ref, env));
  }
  return images;
}

async function chatGptCredentialForTask(task: ImageTaskRow, env: Env): Promise<{ accessToken: string; accountId: string | null }> {
  if (task.target_api_key) {
    return { accessToken: task.target_api_key, accountId: null };
  }

  const storedPayload = parseJsonObject(task.target_payload);
  const requestedAccountId = optionalStringField(storedPayload?.__accountId, 128) ?? optionalStringField(task.account_id, 128);
  const account = requestedAccountId ? await selectAccount(requestedAccountId, env) : await selectNextActiveAccount(env);
  if (account) {
    if (account.status !== "active" || (account.quota_remaining !== null && account.quota_remaining <= 0)) {
      throw new Error("chatgpt_account_not_available");
    }
    await markAccountUsed(account.id, env);
    return { accessToken: account.access_token, accountId: account.id };
  }

  const fallbackSecret = optionalStringField(env.CHATGPT_ACCESS_TOKEN, 4096);
  if (fallbackSecret) {
    return { accessToken: fallbackSecret, accountId: null };
  }

  throw new Error(requestedAccountId ? "chatgpt_account_not_available" : "chatgpt_account_pool_empty");
}

async function selectAccount(accountId: string, env: Env): Promise<ChatGptAccountRow | null> {
  return env.DB.prepare("SELECT * FROM chatgpt_accounts WHERE id = ? AND deleted_at IS NULL").bind(accountId).first<ChatGptAccountRow>();
}

async function selectNextActiveAccount(env: Env): Promise<ChatGptAccountRow | null> {
  return env.DB.prepare(`
    SELECT * FROM chatgpt_accounts
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND (quota_remaining IS NULL OR quota_remaining > 0)
    ORDER BY COALESCE(last_used_at, '1970-01-01T00:00:00.000Z') ASC, created_at ASC
    LIMIT 1
  `).first<ChatGptAccountRow>();
}

async function markAccountUsed(accountId: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE chatgpt_accounts
    SET last_used_at = ?,
        total_uses = total_uses + 1,
        quota_remaining = CASE
          WHEN quota_remaining IS NULL THEN NULL
          WHEN quota_remaining > 0 THEN quota_remaining - 1
          ELSE quota_remaining
        END,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(now, now, accountId)
    .run();
}

async function recordAccountUseResult(accountId: string | null, success: boolean, error: string | null, env: Env): Promise<void> {
  if (!accountId) return;
  const now = new Date().toISOString();
  const errorText = error ? truncate(error, 1000) : null;
  await env.DB.prepare(`
    UPDATE chatgpt_accounts
    SET success_count = success_count + ?,
        failure_count = failure_count + ?,
        status = CASE
          WHEN ? = 1 THEN 'active'
          WHEN ? LIKE '%rate_limit%' OR ? LIKE '%429%' THEN 'rate_limited'
          WHEN ? LIKE '%unauthorized%' OR ? LIKE '%401%' OR ? LIKE '%403%' OR ? LIKE '%token%' THEN 'invalid'
          ELSE status
        END,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
      AND deleted_at IS NULL
  `)
    .bind(success ? 1 : 0, success ? 0 : 1, success ? 1 : 0, errorText, errorText, errorText, errorText, errorText, now, accountId)
    .run();
}

async function loadInputImagesAsDataUrls(objects: StoredInputImageObject[], env: Env): Promise<string[]> {
  const images: string[] = [];
  for (const object of objects) {
    const image = await env.IMAGES.get(object.key);
    if (!image) {
      throw new Error(`input_image_missing:${object.key}`);
    }
    const contentType = normalizeImageContentType(object.contentType);
    const bytes = new Uint8Array(await image.arrayBuffer());
    images.push(`data:${contentType};base64,${bytesToBase64(bytes)}`);
  }
  return images;
}

interface ChatGptWebClientOptions {
  accessToken: string;
  baseUrl: string;
  clientVersion?: string;
  clientBuildNumber?: string;
  requestTimeoutMs: number;
  downloadTimeoutMs: number;
}

interface ChatGptRequirements {
  token: string;
  proofToken?: string;
  soToken?: string;
}

interface ChatGptConversationState {
  conversationId: string;
  fileIds: string[];
  sedimentIds: string[];
  toolInvoked: boolean | null;
  blocked: boolean;
}

class ChatGptWebClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly clientBuildNumber: string;
  private readonly requestTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly deviceId = crypto.randomUUID();
  private readonly sessionId = crypto.randomUUID();
  private powScriptSources = ["/backend-api/sentinel/sdk.js"];
  private powDataBuild = "";

  constructor(options: ChatGptWebClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.clientVersion = options.clientVersion || CHATGPT_DEFAULT_CLIENT_VERSION;
    this.clientBuildNumber = options.clientBuildNumber || CHATGPT_DEFAULT_CLIENT_BUILD_NUMBER;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.downloadTimeoutMs = options.downloadTimeoutMs;
  }

  async checkAccess(): Promise<void> {
    await this.bootstrap();
    await this.getChatRequirements();
  }

  async generateWebImage(prompt: string, model: string): Promise<string[]> {
    await this.bootstrap();
    const requirements = await this.getChatRequirements();
    const conduitToken = await this.prepareImageConversation(prompt, requirements, model);
    const response = await fetchWithTimeout(
      `${this.baseUrl}/backend-api/f/conversation`,
      {
        method: "POST",
        headers: this.imageHeaders("/backend-api/f/conversation", requirements, conduitToken, "text/event-stream"),
        body: JSON.stringify({
          action: "next",
          messages: [
            {
              id: crypto.randomUUID(),
              author: { role: "user" },
              create_time: Date.now() / 1000,
              content: { content_type: "text", parts: [prompt] },
              metadata: {
                developer_mode_connector_ids: [],
                selected_github_repos: [],
                selected_all_github_repos: false,
                system_hints: ["picture_v2"],
                serialization_metadata: { custom_symbol_offsets: [] }
              }
            }
          ],
          parent_message_id: crypto.randomUUID(),
          model: this.imageModelSlug(model),
          client_prepare_state: "sent",
          timezone_offset_min: -480,
          timezone: "Asia/Shanghai",
          conversation_mode: { kind: "primary_assistant" },
          enable_message_followups: true,
          system_hints: ["picture_v2"],
          supports_buffering: true,
          supported_encodings: ["v1"],
          client_contextual_info: {
            is_dark_mode: false,
            time_since_loaded: 1200,
            page_height: 1072,
            page_width: 1724,
            pixel_ratio: 1.2,
            screen_height: 1440,
            screen_width: 2560,
            app_name: "chatgpt.com"
          },
          paragen_cot_summary_display_override: "allow",
          force_parallel_switch: "auto"
        })
      },
      this.requestTimeoutMs
    );
    await ensureOk(response, "/backend-api/f/conversation");
    const state = updateChatGptConversationState(await response.text());
    if (state.blocked) {
      throw new Error("chatgpt_content_blocked");
    }
    if (!state.conversationId) {
      throw new Error("chatgpt_conversation_id_missing");
    }
    return this.pollAndResolveConversationImageUrls(state.conversationId, state.fileIds, state.sedimentIds);
  }

  async generateCodexImage(prompt: string, images: string[], size: string, quality: string): Promise<string[]> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/backend-api/codex/responses`,
      {
        method: "POST",
        headers: new Headers({
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          model: CHATGPT_CODEX_RESPONSES_MODEL,
          instructions: CHATGPT_CODEX_IMAGE_INSTRUCTIONS,
          store: false,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                ...images.map((image) => ({ type: "input_image", image_url: image }))
              ]
            }
          ],
          tools: [
            {
              type: "image_generation",
              model: "gpt-image-2",
              action: images.length > 0 ? "edit" : "generate",
              size,
              quality,
              output_format: "png"
            }
          ],
          tool_choice: { type: "image_generation" },
          stream: true
        })
      },
      this.requestTimeoutMs
    );
    await ensureOk(response, "/backend-api/codex/responses");
    const text = await response.text();
    const imagesFromEvents = extractCodexImageResults(parseSseJsonEvents(text));
    if (imagesFromEvents.length === 0) {
      throw new Error("chatgpt_codex_response_missing_image");
    }
    return imagesFromEvents;
  }

  private async bootstrap(): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/`,
      {
        headers: this.bootstrapHeaders()
      },
      30000
    );
    await ensureOk(response, "chatgpt_bootstrap");
    const html = await response.text();
    this.powScriptSources = extractPowScriptSources(html);
    this.powDataBuild = extractPowDataBuild(html);
  }

  private async getChatRequirements(): Promise<ChatGptRequirements> {
    const path = "/backend-api/sentinel/chat-requirements";
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: this.headers(path, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          p: buildLegacyRequirementsToken(CHATGPT_USER_AGENT, this.powScriptSources, this.powDataBuild)
        })
      },
      30000
    );
    await ensureOk(response, path);
    const data = (await response.json()) as Record<string, unknown>;
    const arkose = objectField(data.arkose);
    if (arkose?.required === true) {
      throw new Error("chatgpt_arkose_required");
    }
    const turnstile = objectField(data.turnstile);
    if (turnstile?.required === true) {
      throw new Error("chatgpt_turnstile_required");
    }
    const token = optionalStringField(data.token, 4096);
    if (!token) {
      throw new Error("chatgpt_requirements_token_missing");
    }
    const proofOfWork = objectField(data.proofofwork);
    const proofToken =
      proofOfWork?.required === true
        ? buildProofToken(
            optionalStringField(proofOfWork.seed, 4096) ?? "",
            optionalStringField(proofOfWork.difficulty, 256) ?? "",
            CHATGPT_USER_AGENT,
            this.powScriptSources,
            this.powDataBuild
          )
        : undefined;
    return {
      token,
      proofToken,
      soToken: optionalStringField(data.so_token, 4096)
    };
  }

  private async prepareImageConversation(prompt: string, requirements: ChatGptRequirements, model: string): Promise<string> {
    const path = "/backend-api/f/conversation/prepare";
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: this.imageHeaders(path, requirements),
        body: JSON.stringify({
          action: "next",
          fork_from_shared_post: false,
          parent_message_id: crypto.randomUUID(),
          model: this.imageModelSlug(model),
          client_prepare_state: "success",
          timezone_offset_min: -480,
          timezone: "Asia/Shanghai",
          conversation_mode: { kind: "primary_assistant" },
          system_hints: ["picture_v2"],
          partial_query: {
            id: crypto.randomUUID(),
            author: { role: "user" },
            content: { content_type: "text", parts: [prompt] }
          },
          supports_buffering: true,
          supported_encodings: ["v1"],
          client_contextual_info: { app_name: "chatgpt.com" }
        })
      },
      60000
    );
    await ensureOk(response, path);
    const payload = (await response.json()) as Record<string, unknown>;
    return optionalStringField(payload.conduit_token, 4096) ?? "";
  }

  private async resolveConversationImageUrls(conversationId: string, fileIds: string[], sedimentIds: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const fileId of fileIds.filter((item) => item !== "file_upload")) {
      const url = await this.getFileDownloadUrl(fileId);
      if (url && !urls.includes(url)) urls.push(url);
    }
    for (const sedimentId of sedimentIds) {
      const url = await this.getAttachmentDownloadUrl(conversationId, sedimentId);
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  private async pollAndResolveConversationImageUrls(
    conversationId: string,
    initialFileIds: string[],
    initialSedimentIds: string[]
  ): Promise<string[]> {
    const fileIds = [...initialFileIds];
    const sedimentIds = [...initialSedimentIds];
    const deadline = Date.now() + Math.max(30000, this.requestTimeoutMs - 15000);
    let lastError = "";

    if (fileIds.length > 0 || sedimentIds.length > 0) {
      const urls = await this.resolveConversationImageUrls(conversationId, fileIds, sedimentIds);
      if (urls.length > 0) return urls;
    } else {
      await sleep(8000);
    }

    while (Date.now() < deadline) {
      try {
        const taskState = await this.queryBackendTasksForImageState(conversationId);
        addUnique(fileIds, taskState.fileIds);
        addUnique(sedimentIds, taskState.sedimentIds);
        if (taskState.error) lastError = taskState.error;
      } catch (error) {
        lastError = errorMessage(error);
      }

      if (fileIds.length > 0 || sedimentIds.length > 0) {
        const urls = await this.resolveConversationImageUrls(conversationId, fileIds, sedimentIds);
        if (urls.length > 0) return urls;
      }

      try {
        const conversationState = await this.getConversationImageState(conversationId);
        addUnique(fileIds, conversationState.fileIds);
        addUnique(sedimentIds, conversationState.sedimentIds);
        if (conversationState.blocked) throw new Error("chatgpt_content_blocked");
      } catch (error) {
        lastError = errorMessage(error);
      }

      if (fileIds.length > 0 || sedimentIds.length > 0) {
        const urls = await this.resolveConversationImageUrls(conversationId, fileIds, sedimentIds);
        if (urls.length > 0) return urls;
      }

      await sleep(8000);
    }

    throw new Error(`chatgpt_image_poll_timeout:${conversationId}${lastError ? `:${truncate(lastError, 300)}` : ""}`);
  }

  private async queryBackendTasksForImageState(conversationId: string): Promise<{ fileIds: string[]; sedimentIds: string[]; error: string }> {
    const path = "/backend-api/tasks";
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      { headers: this.headers(path, { Accept: "application/json" }) },
      Math.min(this.downloadTimeoutMs, 30000)
    );
    await ensureOk(response, path);
    const payload = (await response.json()) as Record<string, unknown>;
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const fileIds: string[] = [];
    const sedimentIds: string[] = [];
    let error = "";
    for (const task of tasks) {
      const record = objectField(task);
      if (!record) continue;
      if (record.conversation_id !== conversationId && record.original_conversation_id !== conversationId) continue;
      const taskText = JSON.stringify(record);
      addUnique(fileIds, extractAll(taskText, /file-service:\/\/([A-Za-z0-9_-]+)/g));
      addUnique(fileIds, extractAll(taskText, /\b(file_00000000[a-f0-9]{24})\b/g));
      addUnique(sedimentIds, extractAll(taskText, /sediment:\/\/([A-Za-z0-9_-]+)/g));
      const message = objectField(record.image_gen_message);
      const metadata = objectField(message?.metadata);
      const content = objectField(message?.content);
      const author = objectField(message?.author);
      if (metadata?.is_error === true && author?.role === "assistant" && content?.content_type === "text") {
        const parts = Array.isArray(content.parts) ? content.parts : [];
        error = parts.filter((part): part is string => typeof part === "string").join("");
      }
    }
    return { fileIds, sedimentIds, error };
  }

  private async getConversationImageState(conversationId: string): Promise<ChatGptConversationState> {
    const path = `/backend-api/conversation/${conversationId}`;
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      { headers: this.headers(path, { Accept: "application/json" }) },
      Math.min(this.downloadTimeoutMs, 60000)
    );
    await ensureOk(response, path);
    const payload = (await response.json()) as unknown;
    const state = updateChatGptConversationState(`data: ${JSON.stringify(payload)}\n\n`);
    const pointers = collectChatGptImagePointers(payload);
    addUnique(state.fileIds, pointers.fileIds);
    addUnique(state.sedimentIds, pointers.sedimentIds);
    return state;
  }

  private async getFileDownloadUrl(fileId: string): Promise<string> {
    const path = `/backend-api/files/${fileId}/download`;
    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: this.headers(path, { Accept: "application/json" }) }, this.downloadTimeoutMs);
    await ensureOk(response, path);
    const payload = (await response.json()) as Record<string, unknown>;
    return optionalStringField(payload.download_url, 4096) ?? optionalStringField(payload.url, 4096) ?? "";
  }

  private async getAttachmentDownloadUrl(conversationId: string, attachmentId: string): Promise<string> {
    const path = `/backend-api/conversation/${conversationId}/attachment/${attachmentId}/download`;
    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: this.headers(path, { Accept: "application/json" }) }, this.downloadTimeoutMs);
    await ensureOk(response, path);
    const payload = (await response.json()) as Record<string, unknown>;
    return optionalStringField(payload.download_url, 4096) ?? optionalStringField(payload.url, 4096) ?? "";
  }

  private headers(path: string, extra?: Record<string, string>): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": CHATGPT_USER_AGENT,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Priority: "u=1, i",
      "Sec-Ch-Ua": CHATGPT_SEC_CH_UA,
      "Sec-Ch-Ua-Arch": '"x86"',
      "Sec-Ch-Ua-Bitness": '"64"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Model": '""',
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "OAI-Device-Id": this.deviceId,
      "OAI-Session-Id": this.sessionId,
      "OAI-Language": "zh-CN",
      "OAI-Client-Version": this.clientVersion,
      "OAI-Client-Build-Number": this.clientBuildNumber,
      "X-OpenAI-Target-Path": path,
      "X-OpenAI-Target-Route": path
    });
    for (const [key, value] of Object.entries(extra ?? {})) {
      headers.set(key, value);
    }
    return headers;
  }

  private imageHeaders(path: string, requirements: ChatGptRequirements, conduitToken = "", accept = "*/*"): Headers {
    const headers = this.headers(path, {
      "Content-Type": "application/json",
      Accept: accept,
      "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token
    });
    if (requirements.proofToken) headers.set("OpenAI-Sentinel-Proof-Token", requirements.proofToken);
    if (requirements.soToken) headers.set("OpenAI-Sentinel-SO-Token", requirements.soToken);
    if (conduitToken) headers.set("X-Conduit-Token", conduitToken);
    if (accept === "text/event-stream") headers.set("X-Oai-Turn-Trace-Id", crypto.randomUUID());
    return headers;
  }

  private bootstrapHeaders(): Headers {
    return new Headers({
      "User-Agent": CHATGPT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Sec-Ch-Ua": CHATGPT_SEC_CH_UA,
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1"
    });
  }

  private imageModelSlug(model: string): string {
    return model === "gpt-image-2" || model === CHATGPT_CODEX_IMAGE_MODEL ? "gpt-image-2" : model || "gpt-image-2";
  }
}

function normalizeAccountStatus(value: unknown, allowUndefined: boolean): ChatGptAccountStatus | undefined {
  const raw = optionalStringField(value, 64);
  if (!raw) {
    if (allowUndefined) return undefined;
    return undefined;
  }
  if (raw === "active" || raw === "inactive" || raw === "invalid" || raw === "rate_limited") return raw;
  throw new HttpError(400, "invalid_account_status");
}

function accountStatusForError(error: string): ChatGptAccountStatus {
  const normalized = error.toLowerCase();
  if (normalized.includes("429") || normalized.includes("rate_limit")) return "rate_limited";
  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("token")
  ) {
    return "invalid";
  }
  return "invalid";
}

function serializeTask(row: ImageTaskRow) {
  return {
    id: row.id,
    uuid: row.uuid,
    ownerType: "user",
    userId: row.uuid,
    status: row.status,
    targetUrl: row.target_url,
    apiKeyHint: row.api_key_hint,
    accountId: row.account_id ?? parseJsonObject(row.target_payload)?.__accountId ?? null,
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
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at
  };
}

function serializeAccount(row: ChatGptAccountRow) {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    tokenHint: row.token_hint,
    status: row.status,
    quotaRemaining: row.quota_remaining,
    quotaLimit: row.quota_limit,
    lastCheckedAt: row.last_checked_at,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    totalUses: row.total_uses,
    successCount: row.success_count,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function imageTaskSourceFor(task: Pick<ImageTaskRow, "target_payload">): ImageTaskSource {
  return parseJsonObject(task.target_payload)?.__source === CHATGPT_WEB_SOURCE ? "chatgpt-web" : "target-api";
}

function chatGptBaseUrl(env: Env, override?: string): string {
  return (override || env.CHATGPT_BASE_URL || CHATGPT_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function appendFormValue(formData: FormData, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(formData, key, item);
    return;
  }
  if (typeof value === "object") {
    formData.append(key, JSON.stringify(value));
    return;
  }
  formData.append(key, String(value));
}

function editUrlFor(targetUrl: string): string {
  return targetUrl.replace(/\/images\/generations(\?.*)?$/i, "/images/edits$1");
}

export function parseSseJsonEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const flush = () => {
    const payload = lines.join("\n").trim();
    lines.length = 0;
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed upstream event chunks. The final missing-image error is clearer.
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      lines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

export function updateChatGptConversationState(text: string): ChatGptConversationState {
  const state: ChatGptConversationState = {
    conversationId: "",
    fileIds: [],
    sedimentIds: [],
    toolInvoked: null,
    blocked: false
  };

  for (const event of parseSseJsonEvents(text)) {
    const payload = JSON.stringify(event);
    const conversationId = firstMatch(payload, /"conversation_id"\s*:\s*"([^"]+)"/);
    if (conversationId && !state.conversationId) state.conversationId = conversationId;

    const value = objectField(event.v);
    const eventConversationId =
      optionalStringField(event.conversation_id, 256) ?? optionalStringField(value?.conversation_id, 256);
    if (eventConversationId) state.conversationId = eventConversationId;

    if (event.type === "moderation" && objectField(event.moderation_response)?.blocked === true) {
      state.blocked = true;
    }
    if (event.type === "server_ste_metadata") {
      const metadata = objectField(event.metadata);
      if (typeof metadata?.tool_invoked === "boolean") state.toolInvoked = metadata.tool_invoked;
    }

    const isUserMessage = isChatGptUserMessageEvent(event);
    const imageContext =
      isChatGptImageToolEvent(event) ||
      (state.toolInvoked === true && !isUserMessage) ||
      (event.o === "patch" && !isUserMessage && (payload.includes("asset_pointer") || payload.includes("file-service://")));

    if (imageContext) {
      addUnique(state.fileIds, extractAll(payload, /file-service:\/\/([A-Za-z0-9_-]+)/g));
      addUnique(state.fileIds, extractAll(payload, /\b(file_00000000[a-f0-9]{24})\b/g));
      addUnique(state.sedimentIds, extractAll(payload, /sediment:\/\/([A-Za-z0-9_-]+)/g));
    }
  }

  return state;
}

export function extractCodexImageResults(value: unknown): string[] {
  const images: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (record.type === "image_generation_call" && typeof record.result === "string" && record.result) {
      images.push(record.result);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return Array.from(new Set(images));
}

export function collectChatGptImagePointers(value: unknown): { fileIds: string[]; sedimentIds: string[] } {
  const fileIds: string[] = [];
  const sedimentIds: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const record = objectField(item);
    if (!record) return;

    if (isChatGptImageMessage(record)) {
      const text = JSON.stringify(record);
      addUnique(fileIds, extractAll(text, /file-service:\/\/([A-Za-z0-9_-]+)/g));
      addUnique(fileIds, extractAll(text, /\b(file_00000000[a-f0-9]{24})\b/g));
      addUnique(sedimentIds, extractAll(text, /sediment:\/\/([A-Za-z0-9_-]+)/g));
    }

    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return { fileIds, sedimentIds };
}

function extractPowScriptSources(html: string): string[] {
  const matches = Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)).map((match) => match[1]);
  return matches.length > 0 ? matches : ["/backend-api/sentinel/sdk.js"];
}

function extractPowDataBuild(html: string): string {
  const scriptBuild = firstMatch(html, /c\/[^/]*\/_/);
  if (scriptBuild) return scriptBuild;
  return firstMatch(html, /<html[^>]*data-build=["']([^"']*)["']/i) ?? "";
}

function buildLegacyRequirementsToken(userAgent: string, scriptSources: string[], dataBuild: string): string {
  const seed = String(Math.random());
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  return `gAAAAAC${solvePow(seed, "0fffff", config)}`;
}

function buildProofToken(
  seed: string,
  difficulty: string,
  userAgent: string,
  scriptSources: string[],
  dataBuild: string
): string {
  return `gAAAAAB${solvePow(seed, difficulty, buildPowConfig(userAgent, scriptSources, dataBuild))}`;
}

function buildPowConfig(userAgent: string, scriptSources: string[], dataBuild: string): unknown[] {
  const now = new Date();
  const eastern = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const parseTime = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][eastern.getUTCDay()]} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][eastern.getUTCMonth()]
  } ${String(eastern.getUTCDate()).padStart(2, "0")} ${eastern.getUTCFullYear()} ${String(eastern.getUTCHours()).padStart(2, "0")}:${String(eastern.getUTCMinutes()).padStart(2, "0")}:${String(eastern.getUTCSeconds()).padStart(2, "0")} GMT-0500 (Eastern Standard Time)`;

  return [
    3000,
    parseTime,
    4294705152,
    0,
    userAgent,
    scriptSources[0] ?? "/backend-api/sentinel/sdk.js",
    dataBuild,
    "en-US",
    "en-US,es-US,en,es",
    0,
    "webdriver−false",
    "location",
    "window",
    Date.now(),
    crypto.randomUUID(),
    "",
    16,
    Date.now()
  ];
}

function solvePow(seed: string, difficulty: string, config: unknown[], limit = 500000): string {
  const target = hexToBytes(difficulty);
  const diffLen = Math.floor(difficulty.length / 2);
  const static1 = `${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`;
  const static2 = `,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`;
  const static3 = `,${JSON.stringify(config.slice(10)).slice(1)}`;
  for (let i = 0; i < limit; i += 1) {
    const candidate = `${static1}${i}${static2}${i >> 1}${static3}`;
    const encoded = btoa(unescape(encodeURIComponent(candidate)));
    const digest = new Uint8Array(sha3_512.arrayBuffer(`${seed}${encoded}`));
    if (compareBytes(digest.slice(0, diffLen), target.slice(0, diffLen)) <= 0) {
      return encoded;
    }
  }
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${btoa(JSON.stringify(seed))}`;
}

function isChatGptImageToolEvent(event: Record<string, unknown>): boolean {
  const value = objectField(event.v);
  const message = objectField(event.message) ?? objectField(value?.message);
  return message ? isChatGptImageMessage(message) : false;
}

function isChatGptImageMessage(message: Record<string, unknown>): boolean {
  const metadata = objectField(message.metadata);
  const author = objectField(message.author);
  const content = objectField(message.content);
  if (author?.role !== "tool") return false;
  if (metadata?.async_task_type === "image_gen") return true;
  if (content?.content_type !== "multimodal_text") return false;
  return Array.isArray(content.parts) && content.parts.some((part) => {
    const record = objectField(part);
    return (
      record?.content_type === "image_asset_pointer" ||
      (typeof record?.asset_pointer === "string" &&
        (record.asset_pointer.startsWith("file-service://") || record.asset_pointer.startsWith("sediment://")))
    );
  });
}

function isChatGptUserMessageEvent(event: Record<string, unknown>): boolean {
  const value = objectField(event.v);
  const message = objectField(event.message) ?? objectField(value?.message);
  const author = objectField(message?.author);
  return String(author?.role ?? "").toLowerCase() === "user";
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function addUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function extractAll(value: string, pattern: RegExp): string[] {
  return Array.from(value.matchAll(pattern)).map((match) => match[1]).filter(Boolean);
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1] ?? value.match(pattern)?.[0];
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function accountAdminPage(): Response {
  const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChatGPT Account Pool</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#1f2328; --muted:#667085; --line:#d0d7de; --accent:#0969da; --bad:#cf222e; --ok:#1a7f37; --warn:#9a6700; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    header { padding:24px 28px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
    h1 { margin:0 0 6px; font-size:24px; font-weight:650; letter-spacing:0; }
    header p { margin:0; color:var(--muted); font-size:14px; }
    main { padding:22px 28px 36px; display:grid; grid-template-columns: minmax(280px, 380px) 1fr; gap:20px; align-items:start; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .panel-title { padding:14px 16px; border-bottom:1px solid var(--line); font-weight:650; }
    form { padding:16px; display:grid; gap:12px; }
    label { display:grid; gap:6px; font-size:13px; color:var(--muted); }
    input, select { width:100%; min-height:38px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font:inherit; color:var(--text); background:#fff; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    button { border:1px solid var(--line); border-radius:6px; min-height:34px; padding:7px 10px; background:#fff; color:var(--text); font:inherit; cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    button.danger { color:var(--bad); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .toolbar { padding:12px 16px; display:flex; gap:10px; align-items:center; border-bottom:1px solid var(--line); }
    .toolbar input { max-width:260px; }
    .status { display:inline-flex; align-items:center; min-height:24px; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:650; background:#eef2f6; }
    .status.active { color:var(--ok); background:#dafbe1; }
    .status.inactive { color:var(--muted); }
    .status.invalid { color:var(--bad); background:#ffebe9; }
    .status.rate_limited { color:var(--warn); background:#fff8c5; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:880px; }
    th, td { padding:11px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:13px; }
    th { color:var(--muted); font-weight:650; background:#fbfbfc; }
    td.actions { white-space:nowrap; }
    .muted { color:var(--muted); }
    .error { color:var(--bad); max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .message { min-height:20px; padding:0 16px 16px; color:var(--muted); font-size:13px; }
    @media (max-width: 880px) { main { grid-template-columns:1fr; padding:16px; } header { padding:20px 16px 14px; } }
  </style>
</head>
<body>
  <header>
    <h1>ChatGPT 账号池</h1>
    <p>维护 ChatGPT Web access token，供 chatgpt-web 生图任务自动选用。</p>
  </header>
  <main>
    <section>
      <div class="panel-title">账号信息</div>
      <form id="account-form">
        <input type="hidden" id="account-id">
        <label>名称<input id="label" maxlength="120" placeholder="主账号 / Plus 账号"></label>
        <label>邮箱<input id="email" maxlength="254" placeholder="name@example.com"></label>
        <label>Access token<input id="access-token" maxlength="4096" placeholder="新增必填；编辑时留空则不修改"></label>
        <div class="row">
          <label>状态<select id="status"><option value="active">active</option><option value="inactive">inactive</option><option value="invalid">invalid</option><option value="rate_limited">rate_limited</option></select></label>
          <label>剩余额度<input id="quota-remaining" type="number" min="0" placeholder="不填为未知"></label>
        </div>
        <label>额度上限<input id="quota-limit" type="number" min="0" placeholder="不填为未知"></label>
        <div class="row">
          <button class="primary" type="submit">保存</button>
          <button type="button" id="reset">清空</button>
        </div>
      </form>
      <div class="message" id="message"></div>
    </section>
    <section>
      <div class="panel-title">账号列表</div>
      <div class="toolbar">
        <input id="search" placeholder="搜索名称、邮箱、token hint">
        <select id="filter-status"><option value="">全部状态</option><option value="active">active</option><option value="inactive">inactive</option><option value="invalid">invalid</option><option value="rate_limited">rate_limited</option></select>
        <button id="refresh">刷新</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>账号</th><th>状态</th><th>Token</th><th>额度</th><th>使用</th><th>最近检查</th><th>错误</th><th>操作</th></tr></thead>
          <tbody id="accounts"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#account-form");
    const tbody = document.querySelector("#accounts");
    const msg = document.querySelector("#message");
    const fields = {
      id: document.querySelector("#account-id"),
      label: document.querySelector("#label"),
      email: document.querySelector("#email"),
      accessToken: document.querySelector("#access-token"),
      status: document.querySelector("#status"),
      quotaRemaining: document.querySelector("#quota-remaining"),
      quotaLimit: document.querySelector("#quota-limit")
    };
    let accounts = [];
    function text(value) { return value === null || value === undefined || value === "" ? "—" : String(value); }
    function setMessage(value) { msg.textContent = value || ""; }
    function formPayload() {
      const payload = {
        label: fields.label.value.trim(),
        email: fields.email.value.trim() || null,
        status: fields.status.value,
        quotaRemaining: fields.quotaRemaining.value === "" ? null : Number(fields.quotaRemaining.value),
        quotaLimit: fields.quotaLimit.value === "" ? null : Number(fields.quotaLimit.value)
      };
      if (fields.accessToken.value.trim()) payload.accessToken = fields.accessToken.value.trim();
      return payload;
    }
    async function request(path, options) {
      const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || body.message || response.statusText);
      return body;
    }
    async function loadAccounts() {
      const params = new URLSearchParams({ limit: "100" });
      const q = document.querySelector("#search").value.trim();
      const status = document.querySelector("#filter-status").value;
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      const body = await request("/accounts?" + params.toString());
      accounts = body.accounts || [];
      tbody.innerHTML = accounts.map((account) => '<tr>' +
        '<td><strong>' + escapeHtml(account.label) + '</strong><div class="muted">' + escapeHtml(text(account.email)) + '</div></td>' +
        '<td><span class="status ' + account.status + '">' + account.status + '</span></td>' +
        '<td>' + escapeHtml(account.tokenHint) + '</td>' +
        '<td>' + escapeHtml(text(account.quotaRemaining)) + ' / ' + escapeHtml(text(account.quotaLimit)) + '</td>' +
        '<td>' + account.totalUses + ' 次<br><span class="muted">成功 ' + account.successCount + ' / 失败 ' + account.failureCount + '</span></td>' +
        '<td>' + escapeHtml(text(account.lastCheckedAt)) + '<br><span class="muted">使用 ' + escapeHtml(text(account.lastUsedAt)) + '</span></td>' +
        '<td class="error" title="' + escapeHtml(text(account.lastError)) + '">' + escapeHtml(text(account.lastError)) + '</td>' +
        '<td class="actions"><button data-action="edit" data-id="' + account.id + '">编辑</button> <button data-action="check" data-id="' + account.id + '">检测</button> <button class="danger" data-action="delete" data-id="' + account.id + '">删除</button></td>' +
      '</tr>').join("");
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
    }
    function resetForm() {
      fields.id.value = ""; fields.label.value = ""; fields.email.value = ""; fields.accessToken.value = ""; fields.status.value = "active"; fields.quotaRemaining.value = ""; fields.quotaLimit.value = "";
      setMessage("");
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const id = fields.id.value;
        const payload = formPayload();
        if (!id && !payload.accessToken) throw new Error("accessToken_required");
        await request(id ? "/accounts/" + id : "/accounts", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
        resetForm();
        await loadAccounts();
        setMessage("已保存");
      } catch (error) { setMessage(error.message); }
    });
    document.querySelector("#reset").addEventListener("click", resetForm);
    document.querySelector("#refresh").addEventListener("click", () => loadAccounts().catch((error) => setMessage(error.message)));
    document.querySelector("#search").addEventListener("input", () => loadAccounts().catch((error) => setMessage(error.message)));
    document.querySelector("#filter-status").addEventListener("change", () => loadAccounts().catch((error) => setMessage(error.message)));
    tbody.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const account = accounts.find((item) => item.id === button.dataset.id);
      if (!account) return;
      try {
        if (button.dataset.action === "edit") {
          fields.id.value = account.id; fields.label.value = account.label; fields.email.value = account.email || ""; fields.accessToken.value = ""; fields.status.value = account.status; fields.quotaRemaining.value = account.quotaRemaining ?? ""; fields.quotaLimit.value = account.quotaLimit ?? "";
          setMessage("正在编辑 " + account.label);
        }
        if (button.dataset.action === "check") {
          button.disabled = true;
          await request("/accounts/" + account.id + "/check", { method: "POST", body: "{}" });
          await loadAccounts();
          setMessage("检测完成");
        }
        if (button.dataset.action === "delete" && confirm("删除账号 " + account.label + "？")) {
          await request("/accounts/" + account.id, { method: "DELETE" });
          await loadAccounts();
          setMessage("已删除");
        }
      } catch (error) { setMessage(error.message); }
      finally { button.disabled = false; }
    });
    loadAccounts().catch((error) => setMessage(error.message));
  </script>
</body>
</html>`;
  return withCors(
    new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    })
  );
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
