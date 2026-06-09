# Image Task Worker

Cloudflare Worker backend for asynchronous image generation tasks.

For practical follow-up development and deployment steps, see [docs/deploy-and-development.md](docs/deploy-and-development.md).

## What it implements

- `POST /tasks`: create an image generation task, write it to D1, enqueue it with Cloudflare Queues, and return a `taskId`.
- `GET /tasks?uuid=...`: list tasks for one or more UUIDs. Repeated or comma-separated `uuid` values are supported.
- `GET /tasks/:taskId`: read one task detail. Add `?uuid=...` to enforce UUID ownership filtering.
- `GET /tasks/:taskId/images/:index`: stream a stored R2 result image when the bucket is not public.
- `GET /health`: lightweight health check.

The create endpoint accepts either the product field names (`url`, `key`, `modelid`) or the clearer aliases (`targetUrl`, `apiKey`, `modelId`). It also accepts a `payload` object. When `payload` is present, the Queue consumer stores it with the task and posts it to the target image API as-is.

Without `payload`, the Queue consumer keeps the previous default body:

```json
{
  "model": "MODEL_ID",
  "prompt": "PROMPT"
}
```

and `Authorization: Bearer API_KEY`. The recommended target response shape is the OpenAI Images format, especially `{ "data": [{ "b64_json": "..." }] }`; `{ "data": [{ "url": "..." }] }` is also supported. Direct `image/*` responses, data URLs, and a few common `images` / `image_url` response shapes remain compatible.

## Data flow

1. Client creates a task with `targetUrl`, `apiKey`, `uuid`, and a target API `payload`.
2. Worker inserts a `queued` row in D1. The API key is stored temporarily because the async consumer needs it.
3. Worker sends `{ taskId }` to `IMAGE_TASK_QUEUE`.
4. Queue consumer loads the task, marks it `running`, and calls the target API. Cloudflare Queues consumers can run long enough for slow image APIs, so this is the long-running worker path.
5. On success, generated images are stored in R2 under `tasks/{uuid}/{taskId}/{index}.{ext}`. D1 is updated to `succeeded`, result object keys/URLs are written, and `target_api_key` is cleared.
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

Deploy:

```bash
npm run deploy
```

## Request examples

Create:

```bash
curl -X POST "$WORKER_URL/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/v1/images/generations",
    "key": "sk-...",
    "payload": {
      "model": "gpt-image-1",
      "prompt": "A clean product render",
      "size": "1024x1024"
    },
    "uuid": "user-or-client-uuid",
    "maxAttempts": 3
  }'
```

List:

```bash
curl "$WORKER_URL/tasks?uuid=user-or-client-uuid&limit=50"
```

Detail:

```bash
curl "$WORKER_URL/tasks/TASK_ID?uuid=user-or-client-uuid"
```

Fetch a private R2 result:

```bash
curl "$WORKER_URL/tasks/TASK_ID/images/0?uuid=user-or-client-uuid" --output result.png
```

## Notes

- `uuid` is treated as the client/query grouping key from the product requirement. It is not authentication by itself.
- `R2_PUBLIC_BASE_URL` can point to an R2 custom domain. If empty, task results return Worker image routes instead of public R2 URLs.
- `DEFAULT_IMAGE_TIMEOUT_SECONDS` defaults to `600`, matching a 10-minute target API wait.
- `IMAGE_DOWNLOAD_TIMEOUT_SECONDS` defaults to `120`, so image URL downloads cannot hang the whole consumer indefinitely.
- `MAX_ATTEMPTS` defaults to `3`; per-task `maxAttempts` can lower or raise this up to `10`.
- Queue processing writes structured JSON logs for task start, success, retry, failure, and skipped messages. Use `npx wrangler tail image-task-worker` to inspect live task timing and result metadata.
