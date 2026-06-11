# Image Task Worker

Cloudflare Worker backend for asynchronous image generation tasks.

For practical follow-up development and deployment steps, see [docs/deploy-and-development.md](docs/deploy-and-development.md).

## What it implements

- `POST /tasks`: create an image generation task, write it to D1, enqueue it with Cloudflare Queues, and return a `taskId`.
- `GET /tasks`: list tasks for the authenticated Clerk user.
- `GET /tasks/:taskId`: read one task detail when it belongs to the authenticated Clerk user.
- `GET /tasks/:taskId/images/:index`: stream a stored R2 result image when the bucket is not public.
- `GET /accounts`, `POST /accounts`, `GET/PATCH/DELETE /accounts/:id`, `POST /accounts/:id/check`: manage the ChatGPT web account pool.
- `GET /admin/accounts`: built-in account pool management UI.
- `GET /health`: lightweight health check.

Task endpoints require `Authorization: Bearer <Clerk session token>`. The Worker verifies the token and stores the Clerk `sub` claim in the existing `uuid` column as the task owner key. Clients must not pass ownership identifiers.

The frontend no longer supplies upstream image API URL, API key, or model. For the default OpenAI-compatible source, the Worker reads:

- `IMAGE_API_URL`
- `IMAGE_API_KEY` as a Worker secret
- `IMAGE_API_MODEL`

The create endpoint accepts a `payload` object from the client, but overwrites `payload.model` with `IMAGE_API_MODEL` and derives `payload.prompt` from the submitted prompt/payload. The recommended target response shape is the OpenAI Images format, especially `{ "data": [{ "b64_json": "..." }] }`; `{ "data": [{ "url": "..." }] }` is also supported. Direct `image/*` responses, data URLs, and a few common `images` / `image_url` response shapes remain compatible.

Set `IMAGE_TASK_SOURCE = "chatgpt-web"` to keep the same D1/Queue/R2 task system while changing the upstream source to the ChatGPT web backend flow referenced by `basketikun/chatgpt2api`. In this mode:

- The normal path is to store ChatGPT web access tokens in the server-side account pool. Task creation can omit `key`.
- `accountId` can pin a task to one account. If omitted, the queue consumer selects the least recently used active account with remaining quota.
- If the account pool is empty, the queue consumer can fall back to the Worker secret `CHATGPT_ACCESS_TOKEN`.
- `CHATGPT_BASE_URL` controls the ChatGPT web backend base URL and defaults to `https://chatgpt.com`.
- `payload.model: "gpt-image-2"` uses the ChatGPT conversation image flow: bootstrap, sentinel chat requirements, prepare, conversation SSE, task/conversation polling, and attachment download.
- `payload.model: "codex-gpt-image-2"` uses the Codex Responses image flow and extracts `image_generation_call.result` values.
- The Worker implements a simple D1-backed account pool, but not browser challenge solving or relogin. If the web backend asks for Arkose/Turnstile or the token is invalid, account checks/tasks record the failure.

## Data flow

1. Client signs in with Clerk and creates a task with a Bearer session token plus prompt/payload.
2. Worker inserts a `queued` row in D1. For `chatgpt-web`, the task stores an optional `accountId`; the queue consumer loads the token from `chatgpt_accounts`.
3. Worker sends `{ taskId }` to `IMAGE_TASK_QUEUE`.
4. Queue consumer loads the task, marks it `running`, and calls the target API. Cloudflare Queues consumers can run long enough for slow image APIs, so this is the long-running worker path.
5. On success, generated images are stored in R2 under `tasks/{userId}/{taskId}/{index}.{ext}`. D1 is updated to `succeeded`, result object keys/URLs are written, and `target_api_key` is cleared.
6. On failure, the task is retried with exponential delay until `maxAttempts`. Final failure updates D1 to `failed`, records the error, and clears `target_api_key`.

## Setup

Create the Cloudflare resources:

```bash
npx wrangler d1 create image-task-db
npx wrangler r2 bucket create image-task-results
npx wrangler queues create image-task-queue
npx wrangler queues create image-task-dlq
```

Put the returned D1 `database_id` into `wrangler.toml`, then apply the migration:

```bash
npx wrangler d1 migrations apply image-task-db
```

Run locally:

```bash
npm install
npm run dev
```

Set required secrets before a real deployment:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put IMAGE_API_KEY
```

Optional auth/config values:

- `CLERK_JWT_KEY`: use Clerk JWT key verification instead of the secret key.
- `CLERK_AUTHORIZED_PARTIES`: comma-separated allowed frontend origins for Clerk token `azp`.
- `IMAGE_TASK_SOURCE`: `target-api` or `chatgpt-web`.
- `IMAGE_API_URL` / `IMAGE_API_MODEL`: non-secret upstream defaults in `wrangler.toml`.

Deploy:

```bash
npm run deploy
```

## Project Structure

- `src/index.ts`: Worker entrypoint, routing, task lifecycle, queue consumer, upstream adapters, and serializers.
- `src/types.ts`: Worker bindings, request/row/domain types shared across modules and tests.
- `src/auth.ts`: Clerk bearer-token verification and task auth context extraction.
- `src/core.ts`: shared Worker response, CORS, timeout, parsing, and error helpers.
- `src/image-codecs.ts`: image response parsing, reference extraction, base64/data URL decoding, and content-type helpers.
- `test/image-response.test.ts`: contract tests for task auth, source selection, image parsing, queue processing, and account APIs.
- `migrations/`: append-only D1 schema migrations.
- `docs/deploy-and-development.md`: operational setup, deploy, and troubleshooting guide.

## Checks

```bash
npm run check
```

`check` runs TypeScript, Vitest, and a Wrangler dry-run deploy package check.

## Request examples

Create:

```bash
curl -X POST "$WORKER_URL/tasks" \
  -H "Authorization: Bearer $CLERK_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "prompt": "A clean product render",
      "size": "1024x1024"
    },
    "maxAttempts": 3
  }'
```

Create with the ChatGPT web source:

```bash
curl -X POST "$WORKER_URL/tasks" \
  -H "Authorization: Bearer $CLERK_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "model": "gpt-image-2",
      "prompt": "A clean product render",
      "size": "1024x1024",
      "quality": "auto"
    },
    "maxAttempts": 3
  }'
```

Add a ChatGPT web account:

```bash
curl -X POST "$WORKER_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "main-plus-account",
    "email": "user@example.com",
    "accessToken": "CHATGPT_WEB_ACCESS_TOKEN",
    "quotaRemaining": 100,
    "quotaLimit": 100,
    "status": "active"
  }'
```

Open the management UI at:

```text
$WORKER_URL/admin/accounts
```

List:

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks?limit=50"
```

Detail:

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID"
```

Fetch a private R2 result:

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID/images/0" --output result.png
```

## Notes

- The D1 column is still named `uuid` for migration compatibility, but new rows store the Clerk user ID there.
- `R2_PUBLIC_BASE_URL` can point to an R2 custom domain. If empty, task results return Worker image routes instead of public R2 URLs.
- `DEFAULT_IMAGE_TIMEOUT_SECONDS` defaults to `600`, matching a 10-minute target API wait.
- `IMAGE_DOWNLOAD_TIMEOUT_SECONDS` defaults to `120`, so image URL downloads cannot hang the whole consumer indefinitely.
- Prefer the account pool over per-task tokens. `CHATGPT_ACCESS_TOKEN` remains a fallback secret for deployments that do not use `/accounts`.
- `CHATGPT_BASE_URL`, `CHATGPT_CLIENT_VERSION`, and `CHATGPT_CLIENT_BUILD_NUMBER` can override the ChatGPT web defaults when the upstream web protocol changes.
- `MAX_ATTEMPTS` defaults to `3`; per-task `maxAttempts` can lower or raise this up to `10`.
- Queue processing writes structured JSON logs for task start, success, retry, failure, and skipped messages. Use `npx wrangler tail image-task-worker` to inspect live task timing and result metadata.
