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
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/v1/images/generations",
    "key": "sk-...",
    "payload": {
      "model": "gpt-image-1",
      "prompt": "A clean product render",
      "size": "1024x1024"
    },
    "uuid": "test-user-001",
    "maxAttempts": 3
  }'
```

列表查询：

```bash
curl "$WORKER_URL/tasks?uuid=test-user-001&limit=20"
```

详情查询：

```bash
curl "$WORKER_URL/tasks/TASK_ID?uuid=test-user-001"
```

如果任务成功且返回的是私有 R2 代理 URL，下载图片：

```bash
curl "$WORKER_URL/tasks/TASK_ID/images/0?uuid=test-user-001" --output result.png
```

## 4. 常用配置

在 `wrangler.toml` 的 `[vars]` 中调整：

```toml
MAX_ATTEMPTS = "3"
DEFAULT_IMAGE_TIMEOUT_SECONDS = "600"
IMAGE_DOWNLOAD_TIMEOUT_SECONDS = "120"
R2_PUBLIC_BASE_URL = ""
```

含义：

- `MAX_ATTEMPTS`：默认最大尝试次数，单个任务也可传 `maxAttempts`，范围 1-10。
- `DEFAULT_IMAGE_TIMEOUT_SECONDS`：目标生图 API 调用超时，默认 600 秒。
- `IMAGE_DOWNLOAD_TIMEOUT_SECONDS`：目标 API 返回图片 URL 时，下载图片的超时。
- `R2_PUBLIC_BASE_URL`：如果 R2 配了公开自定义域名，填这个域名；否则保持空，系统会返回 Worker 图片代理地址。

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

当前 `uuid` 只是查询分组，不是认证。生产环境至少补一个安全层：

- 前端请求带业务登录态或签名。
- Worker 校验用户身份后，只允许查询自己的 `uuid`。
- 不要把目标生图 API 的 key 暴露给不可信客户端；更安全的做法是服务端按业务映射 key，客户端只传模型和 prompt。

当前实现会在任务完成或最终失败后清空 D1 内的 `target_api_key`，但任务运行期间 D1 仍会临时保存 key。若安全要求更高，应改成用 Cloudflare Secrets 或后端 key 映射，不让客户端提交真实 key。

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
curl "$WORKER_URL/tasks/TASK_ID?uuid=UUID"
```

常见原因是目标 API 返回非 2xx、目标响应里没有图片、图片 URL 下载失败、目标 API key 不可用。

### 图片访问不到

如果 `R2_PUBLIC_BASE_URL` 为空，用 Worker 代理地址：

```bash
curl "$WORKER_URL/tasks/TASK_ID/images/0?uuid=UUID" --output result.png
```

如果配置了 `R2_PUBLIC_BASE_URL`，确认 R2 bucket 的公开域名和对象路径可访问。
