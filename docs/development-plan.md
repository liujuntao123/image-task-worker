# 图像生成任务后端开发计划

## 我对需求的完整理解

目标是用 Cloudflare 的 D1、R2 和 Worker 做一套异步图像生成任务接口。用户创建任务时传入目标生图 API 的 `url`、`key`、请求 `payload`，以及一个用于后续批量查询的 `UUID`。创建接口不能同步等待 1-10 分钟，而是先把任务写入 D1，再把任务投递给 Cloudflare 的长时异步执行机制。异步任务调用目标生图 API，等待图片返回；成功则把图片写入 R2、把结果写回 D1；失败则按策略自动重试，超过上限后把失败状态和原因写回 D1。

Cloudflare 上适合这个场景的机制是 **Cloudflare Queues**。HTTP Worker 作为 producer 创建任务并发消息，Queue consumer 在后台处理任务。Queues consumer 的 wall-clock 时间可以覆盖慢图像 API 的 1-10 分钟等待窗口。

## 补充的必要功能

- 任务状态机：`queued`、`running`、`succeeded`、`failed`。
- 自动重试：保存 `attempts`、`maxAttempts`，失败后延迟重试，最终失败落库。
- 结果存储：图片二进制进入 R2，D1 只保存对象 key 和可访问 URL。
- 查询安全边界：详情和图片读取支持 `?uuid=...` 过滤，避免只靠 task id 暴露跨 UUID 数据。
- API key 处理：D1 临时保存目标 API key 给异步 consumer 使用；任务成功或最终失败后清空，只保留 `apiKeyHint`。
- 输入校验：校验 URL、必填字段、长度、重试次数范围。
- 列表分页：`limit` 和 `offset`，防止单次 UUID 查询过大。
- 私有/公开 R2 两种模式：配置 `R2_PUBLIC_BASE_URL` 时返回公开对象 URL；未配置时通过 Worker 图片代理接口读取。
- 图片 URL 下载独立超时：目标 API 返回远程图片 URL 时，下载阶段也必须有超时，避免 consumer 卡住。
- CORS 和健康检查：方便前端直接接入与部署检查。

## 接口设计

### 创建任务

`POST /tasks`

请求：

```json
{
  "url": "https://api.example.com/v1/images/generations",
  "key": "sk-...",
  "payload": {
    "model": "gpt-image-1",
    "prompt": "A clean product render",
    "size": "1024x1024"
  },
  "uuid": "client-or-user-uuid",
  "maxAttempts": 3
}
```

接口也兼容 `targetUrl`、`apiKey`、`modelId` 这组三个别名，方便工程代码使用更清晰的字段。没有传 `payload` 时，会兼容旧逻辑，用 `modelid/modelId` 和 `prompt` 组装 `{ "model": "...", "prompt": "..." }`。

响应：

```json
{
  "taskId": "generated-task-id",
  "uuid": "client-or-user-uuid",
  "status": "queued",
  "createdAt": "2026-06-08T00:00:00.000Z"
}
```

### 批量列表

`GET /tasks?uuid=UUID_A&uuid=UUID_B&limit=50&offset=0`

也支持 `GET /tasks?uuid=UUID_A,UUID_B`。

### 任务详情

`GET /tasks/:taskId?uuid=UUID`

`uuid` 可选，但建议业务侧总是传入，用作查询归属过滤。

### 私有图片读取

`GET /tasks/:taskId/images/:index?uuid=UUID`

当 R2 桶没有公开域名时，任务结果里的 `resultUrls` 会指向这个 Worker 路由。

## 处理流程

1. HTTP Worker 校验创建请求。
2. 插入 D1：状态为 `queued`，保存目标 API 参数、UUID、最大重试次数和时间戳。
3. 发送 `{ taskId }` 到 Cloudflare Queue。
4. Queue consumer 收到消息后读取 D1；如果任务已结束则 ack。
5. 更新状态为 `running`，`attempts + 1`。
6. POST 调用目标生图 API：`Authorization: Bearer key`，body 优先使用创建任务时保存的 `payload`。
7. 解析目标响应，推荐 OpenAI Images 风格 `data[].b64_json`，同时兼容 `data[].url`、`image/*`、data URL 和常见 `images` 字段。
8. 下载或解码图片，写入 R2。
9. 成功：D1 更新为 `succeeded`，写入 R2 key/URL，清空 `target_api_key`，ack 队列消息。
10. 失败且未到重试上限：D1 回到 `queued`，记录错误，`message.retry({ delaySeconds })`。
11. 失败且达到上限：D1 更新为 `failed`，记录最终错误，清空 `target_api_key`，ack 队列消息。

## 部署资源

需要创建：

- D1 database：`image-task-db`
- R2 bucket：`image-task-results`
- Queue：`image-task-queue`
- Dead letter queue：`image-task-dlq`

`wrangler.toml` 已包含绑定模板，创建 D1 后需要把实际 `database_id` 替换进去。

## 验证计划

- `npm run typecheck`：验证 Worker、D1、R2、Queue 类型使用。
- `npm test`：验证目标 API 图片响应解析逻辑。
- `sqlite3` 执行 migration：验证 D1 表结构 SQL 语法。
- `npx wrangler deploy --dry-run --outdir .wrangler-dry-run`：验证 Worker 能被 Wrangler 打包并识别 D1/R2/Queue 绑定。
