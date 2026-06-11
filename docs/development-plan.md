# 图像生成任务后端开发计划

## 当前应用化改造修订

当前版本已经从“客户端传 `uuid`/上游 URL/key/model 的个人工具”升级为“Clerk 登录后的多用户应用”：

- 前端任务接口必须带 `Authorization: Bearer <Clerk session token>`。
- Worker 校验 Clerk token，把 token 的 `sub` 作为任务归属 ID。D1 现有列名仍为 `uuid`，但新语义是 Clerk user ID。
- `GET /tasks`、`GET /tasks/:id`、`GET /tasks/:id/images/:index`、`DELETE /tasks/:id` 都只作用于当前 Clerk 用户，不再接受客户端 `uuid` 过滤。
- 默认 OpenAI-compatible 上游的 `IMAGE_API_URL`、`IMAGE_API_MODEL` 来自 `wrangler.toml`，`IMAGE_API_KEY` 来自 Worker secret。
- 前端只提交 prompt、尺寸、质量、参考图和遮罩；不会再提供 Worker URL、目标 API URL、API key、模型的用户配置入口。
- `IMAGE_TASK_SOURCE = "chatgpt-web"` 时仍复用账号池/ChatGPT web 适配器，但任务归属仍由 Clerk user ID 决定。

## 我对需求的完整理解

目标是保留现有 Cloudflare D1、R2、Worker 和 Queue 的异步图像任务体系。HTTP 创建任务仍然只负责校验、入库和投递队列；Queue consumer 仍然负责慢速上游调用、重试、下载图片、写 R2、回写 D1。变化点只是上游源 API：除了原来的 OpenAI-compatible `targetUrl` 透传模式，新增 `source: "chatgpt-web"`，参考 `basketikun/chatgpt2api` 里的 ChatGPT 官网请求方法，通过 ChatGPT web backend 触发生图。

这个理解很关键：不是把 Worker 改成同步代理，也不是把整套 `chatgpt2api` 的账号池、网页登录、Turnstile/Arkose 解法搬进 Worker；而是在当前任务系统里增加一个上游适配器。适配器使用已登录 ChatGPT access token，执行官网请求序列，并把最终图片归一化成现有的 R2/D1 结果。

Cloudflare 上适合这个场景的机制是 **Cloudflare Queues**。HTTP Worker 作为 producer 创建任务并发消息，Queue consumer 在后台处理任务。Queues consumer 的 wall-clock 时间可以覆盖慢图像 API 的 1-10 分钟等待窗口。

## 补充的必要功能

- 任务状态机：`queued`、`running`、`succeeded`、`failed`。
- 自动重试：保存 `attempts`、`maxAttempts`，失败后延迟重试，最终失败落库。
- 结果存储：图片二进制进入 R2，D1 只保存对象 key 和可访问 URL。
- 查询安全边界：详情和图片读取由 Clerk user ID 过滤，避免只靠 task id 暴露跨用户数据。
- API key 处理：D1 临时保存目标 API key 给异步 consumer 使用；任务成功或最终失败后清空，只保留 `apiKeyHint`。
- 输入校验：校验 URL、必填字段、长度、重试次数范围。
- 列表分页：`limit` 和 `offset`，防止单次 UUID 查询过大。
- 私有/公开 R2 两种模式：配置 `R2_PUBLIC_BASE_URL` 时返回公开对象 URL；未配置时通过 Worker 图片代理接口读取。
- 图片 URL 下载独立超时：目标 API 返回远程图片 URL 时，下载阶段也必须有超时，避免 consumer 卡住。
- ChatGPT web 源适配器：支持 `gpt-image-2` 的 conversation/SSE/任务轮询/附件下载链路，以及 `codex-gpt-image-2` 的 Codex Responses SSE 链路。
- CORS 和健康检查：方便前端直接接入与部署检查。

## 当前接口设计

`POST /tasks`、`GET /tasks`、`GET /tasks/:taskId`、`GET /tasks/:taskId/images/:index` 和 `DELETE /tasks/:taskId` 都需要 `Authorization: Bearer <Clerk session token>`。

创建任务时，客户端只传 `payload.prompt`、`payload.size`、`payload.quality`、参考图和遮罩。Worker 从环境变量读取上游源配置，并把 Clerk user ID 写入任务归属字段。

列表、详情、私有图片读取和删除都不再接受客户端 `uuid` 过滤；Worker 只查询当前 Clerk 用户自己的任务。

当 R2 桶没有公开域名时，任务结果里的 `resultUrls` 会指向这个 Worker 路由。

## 处理流程

1. HTTP Worker 校验创建请求。
2. 插入 D1：状态为 `queued`，保存目标 API 参数、UUID、最大重试次数和时间戳。
3. 发送 `{ taskId }` 到 Cloudflare Queue。
4. Queue consumer 收到消息后读取 D1；如果任务已结束则 ack。
5. 更新状态为 `running`，`attempts + 1`。
6. Queue consumer 根据任务内的 `__source` 选择上游适配器：默认 OpenAI-compatible target API；或 ChatGPT web source。
7. OpenAI-compatible 模式：POST 调用目标生图 API，`Authorization: Bearer key`，body 优先使用创建任务时保存的 `payload`。
8. ChatGPT web 模式：使用 ChatGPT access token 调用官网 backend。`gpt-image-2` 走 bootstrap、sentinel chat requirements、prepare、conversation SSE、`/backend-api/tasks`/conversation 轮询和附件下载；`codex-gpt-image-2` 走 `/backend-api/codex/responses` SSE 并提取 `image_generation_call.result`。
9. 解析目标响应，OpenAI-compatible 模式兼容 `data[].b64_json`、`data[].url`、`image/*`、data URL 和常见 `images` 字段；ChatGPT web 模式归一成图片 URL 或 base64。
10. 下载或解码图片，写入 R2。
11. 成功：D1 更新为 `succeeded`，写入 R2 key/URL，清空 `target_api_key`，ack 队列消息。
12. 失败且未到重试上限：D1 回到 `queued`，记录错误，`message.retry({ delaySeconds })`。
13. 失败且达到上限：D1 更新为 `failed`，记录最终错误，清空 `target_api_key`，ack 队列消息。

## 部署资源

需要创建：

- D1 database：`image-task-db`
- R2 bucket：`image-task-results`
- Queue：`image-task-queue`
- Dead letter queue：`image-task-dlq`

`wrangler.toml` 已包含绑定模板，创建 D1 后需要把实际 `database_id` 替换进去。

## 验证计划

- `npm run typecheck`：验证 Worker、D1、R2、Queue 类型使用。
- `npm test`：验证目标 API 图片响应解析逻辑、ChatGPT web SSE/Codex 结果提取，以及 `source: "chatgpt-web"` 仍走创建任务和队列投递路径。
- `sqlite3` 执行 migration：验证 D1 表结构 SQL 语法。
- `npx wrangler deploy --dry-run --outdir .wrangler-dry-run`：验证 Worker 能被 Wrangler 打包并识别 D1/R2/Queue 绑定。
