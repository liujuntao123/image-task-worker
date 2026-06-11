# 后续开发与部署指南

这份文档只覆盖实际操作。项目目录：

```bash
cd /home/admin1/myspace/image-task-worker
```

## 1. 本地开发

安装依赖：

```bash
npm install
```

常用检查：

```bash
npm run typecheck
npm test
```

本地启动 Worker：

```bash
npm run dev
```

本地开发主要改这些文件：

- `src/index.ts`：HTTP 接口、队列 consumer、D1/R2 读写逻辑。
- `migrations/*.sql`：D1 表结构变更。
- `wrangler.toml`：Cloudflare 绑定、队列、环境变量。
- `test/*.test.ts`：响应解析、纯逻辑测试。

每次改完至少跑：

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir .wrangler-dry-run-check
```

## 2. 首次部署 Cloudflare 资源

登录 Cloudflare：

```bash
npx wrangler login
```

创建 D1、R2、Queue：

```bash
npx wrangler d1 create image-task-db
npx wrangler r2 bucket create image-task-results
npx wrangler queues create image-task-queue
npx wrangler queues create image-task-dlq
```

D1 创建后会返回 `database_id`。把它填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "image-task-db"
database_id = "这里换成真实 database_id"
```

应用 D1 migration：

```bash
npx wrangler d1 migrations apply image-task-db
```

部署 Worker：

```bash
npm run deploy
```

部署完成后记下 Worker URL，例如：

```bash
export WORKER_URL="https://image-task-worker.<你的账号>.workers.dev"
```

## 3. 部署后验证

健康检查：

```bash
curl "$WORKER_URL/health"
```

创建任务：

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

列表查询：

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks?limit=20"
```

详情查询：

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID"
```

如果任务成功且返回的是私有 R2 代理 URL，下载图片：

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID/images/0" --output result.png
```

## 4. 常用配置

在 `wrangler.toml` 的 `[vars]` 中调整：

```toml
MAX_ATTEMPTS = "3"
DEFAULT_IMAGE_TIMEOUT_SECONDS = "600"
IMAGE_DOWNLOAD_TIMEOUT_SECONDS = "120"
IMAGE_TASK_SOURCE = "target-api"
IMAGE_API_URL = "https://sub.aizhi.site/v1/images/generations"
IMAGE_API_MODEL = "gpt-image-2"
CHATGPT_BASE_URL = "https://chatgpt.com"
CHATGPT_CLIENT_VERSION = "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887"
CHATGPT_CLIENT_BUILD_NUMBER = "6708908"
R2_PUBLIC_BASE_URL = ""
```

含义：

- `MAX_ATTEMPTS`：默认最大尝试次数，单个任务也可传 `maxAttempts`，范围 1-10。
- `DEFAULT_IMAGE_TIMEOUT_SECONDS`：目标生图 API 调用超时，默认 600 秒。
- `IMAGE_DOWNLOAD_TIMEOUT_SECONDS`：目标 API 返回图片 URL 时，下载图片的超时。
- `IMAGE_TASK_SOURCE`：`target-api` 或 `chatgpt-web`，控制 Worker 使用哪个上游生图源。
- `IMAGE_API_URL` / `IMAGE_API_MODEL`：默认 OpenAI-compatible 生图接口地址和模型。
- `CHATGPT_BASE_URL`：`IMAGE_TASK_SOURCE = "chatgpt-web"` 时的 ChatGPT web backend 地址，默认 `https://chatgpt.com`。
- `CHATGPT_CLIENT_VERSION` / `CHATGPT_CLIENT_BUILD_NUMBER`：ChatGPT web 请求头版本，参考 `chatgpt2api` 的官网请求方法；上游变更时可更新。
- `R2_PUBLIC_BASE_URL`：如果 R2 配了公开自定义域名，填这个域名；否则保持空，系统会返回 Worker 图片代理地址。

密钥不要写入 `wrangler.toml`：

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put IMAGE_API_KEY
```

可选：

- `CLERK_JWT_KEY`：用 Clerk JWT key 校验代替 secret key。
- `CLERK_AUTHORIZED_PARTIES`：逗号分隔的前端来源，用于校验 Clerk token 的 `azp`。

ChatGPT web access token 不要写进 `wrangler.toml`。推荐通过账号池维护：

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

管理界面：

```text
$WORKER_URL/admin/accounts
```

如果暂时不使用账号池，也可以把单个 token 作为 fallback secret：

```bash
npx wrangler secret put CHATGPT_ACCESS_TOKEN
```

创建 ChatGPT web 源任务：

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

先把 `IMAGE_TASK_SOURCE` 设为 `chatgpt-web`。这个请求不需要传 `key`；队列 consumer 会从 `active` 且还有额度的账号里选择最近最少使用的账号。也可以传 `accountId` 固定使用某个账号；如果账号池为空，可使用 Worker secret `CHATGPT_ACCESS_TOKEN` 作为 fallback。

若用 `codex-gpt-image-2`，consumer 会走 ChatGPT Codex Responses 图片链路。ChatGPT web 模式依赖可用的已登录 access token；如果上游要求 Arkose/Turnstile 或 token 失效，账号检测/任务会记录错误并进入现有重试/最终失败流程。

## 5. 后续改表流程

不要直接改已上线的 migration。新增一个 migration：

```bash
npx wrangler d1 migrations create image-task-db add_xxx_field
```

编辑新生成的 SQL 文件后，本地先用 sqlite 检查语法：

```bash
rm -f /tmp/image-task-worker-migration.db
sqlite3 /tmp/image-task-worker-migration.db < migrations/0001_create_image_tasks.sql
sqlite3 /tmp/image-task-worker-migration.db < migrations/新迁移文件.sql
```

确认无误后应用到 Cloudflare：

```bash
npx wrangler d1 migrations apply image-task-db
```

再部署 Worker：

```bash
npm run deploy
```

## 6. 生产安全注意事项

任务接口已经要求 Clerk Bearer token。Worker 使用 Clerk token 的 `sub` 作为任务归属 ID，并只允许当前用户读取、下载或删除自己的任务。

不要把目标生图 API 的 key 暴露给前端。默认 OpenAI-compatible 模式下，前端只传 prompt、尺寸、质量和参考图；`IMAGE_API_KEY` 只作为 Worker secret 存在。任务运行期间 D1 会临时保存本次消费所需的 key，任务成功或最终失败后会清空 `target_api_key`。

## 7. 常见问题

### D1 database_id 没替换

症状：`wrangler deploy` 或 dry-run 绑定异常。

处理：运行 `npx wrangler d1 create image-task-db`，把返回的 `database_id` 写入 `wrangler.toml`。

### 任务一直 queued

检查：

```bash
npx wrangler queues list
npx wrangler tail image-task-worker
```

重点看 Queue 是否创建、consumer 是否绑定、目标 API 是否超时或报错。

队列 consumer 会输出结构化 JSON 日志，事件包括：

- `image_task_start`：任务开始，含 `taskId`、`uuid`、`attempt`、`targetUrl`、`modelId`、`startedAt`。
- `image_task_success`：任务成功，含 `completedAt`、`durationMs`、`imageCount`、R2 对象 key 和大小。
- `image_task_retry`：任务将重试，含错误、耗时和延迟秒数。
- `image_task_failure`：任务最终失败，含 `failedAt`、`durationMs` 和错误。
- `image_task_skip`：任务已结束或不存在时跳过。

查看实时日志：

```bash
npx wrangler tail image-task-worker
```

### 任务 failed

查详情里的 `error` 字段：

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID"
```

常见原因是目标 API 返回非 2xx、目标响应里没有图片、图片 URL 下载失败、目标 API key 不可用。

### 图片访问不到

如果 `R2_PUBLIC_BASE_URL` 为空，用 Worker 代理地址：

```bash
curl -H "Authorization: Bearer $CLERK_SESSION_TOKEN" "$WORKER_URL/tasks/TASK_ID/images/0" --output result.png
```

如果配置了 `R2_PUBLIC_BASE_URL`，确认 R2 bucket 的公开域名和对象路径可访问。
