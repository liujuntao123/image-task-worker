import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyToken } from "@clerk/backend";
import worker, {
  collectChatGptImagePointers,
  extractCodexImageResults,
  extractImageReferences,
  type Env,
  parseImageApiResponse,
  parseSseJsonEvents,
  targetRequestBodyForTask,
  targetRequestForTask,
  updateChatGptConversationState
} from "../src/index";

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async () => mockClerkPayload())
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(verifyToken).mockResolvedValue(mockClerkPayload());
});

type MockClerkPayload = Awaited<ReturnType<typeof verifyToken>>;

function mockClerkPayload(overrides: Partial<MockClerkPayload> = {}): MockClerkPayload {
  const payload = {
    __raw: "mock.jwt.token",
    azp: "http://localhost:5174",
    exp: 4102444800,
    iat: 1781046000,
    iss: "https://clerk.example",
    nbf: 1781046000,
    sid: "sess_1",
    sub: "user-1",
    v: 2,
    ...overrides
  };
  return payload as MockClerkPayload;
}

describe("extractImageReferences", () => {
  it("extracts OpenAI-compatible image URLs", () => {
    expect(
      extractImageReferences({
        data: [
          {
            url: "https://example.com/image.png"
          }
        ]
      })
    ).toEqual(["https://example.com/image.png"]);
  });

  it("extracts base64 image payloads", () => {
    expect(
      extractImageReferences({
        images: [
          {
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
          }
        ]
      })
    ).toEqual(["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="]);
  });

  it("does not treat ordinary text output as base64 images", () => {
    expect(
      extractImageReferences({
        output: "plain text response"
      })
    ).toEqual([]);
  });

  it("deduplicates common nested image fields", () => {
    expect(
      extractImageReferences({
        output: [
          {
            image_url: "https://example.com/image.webp"
          }
        ],
        result: {
          images: ["https://example.com/image.webp"]
        }
      })
    ).toEqual(["https://example.com/image.webp"]);
  });
});

describe("parseImageApiResponse", () => {
  it("accepts direct image responses", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "image/png"
      }
    });

    await expect(parseImageApiResponse(response)).resolves.toEqual([
      {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png"
      }
    ]);
  });

  it("accepts JSON data URLs", async () => {
    const response = Response.json({
      data: [
        {
          image: "data:image/png;base64,AQID"
        }
      ]
    });

    const images = await parseImageApiResponse(response);
    expect(images[0].contentType).toBe("image/png");
    expect([...images[0].bytes]).toEqual([1, 2, 3]);
  });

  it("accepts OpenAI Images b64_json data responses", async () => {
    const response = Response.json({
      data: [
        {
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      ]
    });

    const images = await parseImageApiResponse(response);
    expect(images[0].contentType).toBe("image/png");
    expect(images[0].bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("targetRequestBodyForTask", () => {
  it("passes through the stored payload when available", () => {
    expect(
      targetRequestBodyForTask({
        target_payload: JSON.stringify({
          model: "gpt-image-1",
          prompt: "A clean product render",
          size: "1024x1024",
          quality: "high"
        }),
        model_id: "ignored-model",
        prompt: "ignored prompt"
      })
    ).toBe('{"model":"gpt-image-1","prompt":"A clean product render","size":"1024x1024","quality":"high"}');
  });

  it("keeps the previous model and prompt body for old tasks", () => {
    expect(
      targetRequestBodyForTask({
        target_payload: null,
        model_id: "image-model",
        prompt: "A clean product render"
      })
    ).toBe('{"model":"image-model","prompt":"A clean product render"}');
  });
});

describe("ChatGPT web source helpers", () => {
  it("parses SSE JSON events and ignores protocol sentinels", () => {
    expect(parseSseJsonEvents('data: "v1"\n\ndata: {"type":"server_ste_metadata"}\n\ndata: [DONE]\n\n')).toEqual([
      { type: "server_ste_metadata" }
    ]);
  });

  it("extracts generated image pointers from ChatGPT conversation SSE", () => {
    const text = [
      'data: {"type":"server_ste_metadata","metadata":{"tool_invoked":true},"conversation_id":"conv-1"}',
      "",
      'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"add","v":{"content_type":"image_asset_pointer","asset_pointer":"file-service://file_00000000aaaaaaaaaaaaaaaaaaaaaaaa"}}],"conversation_id":"conv-1"}',
      "",
      'data: {"v":{"message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"sediment://sediment-1"}]}},"conversation_id":"conv-1"}}',
      ""
    ].join("\n");

    expect(updateChatGptConversationState(text)).toMatchObject({
      conversationId: "conv-1",
      fileIds: ["file_00000000aaaaaaaaaaaaaaaaaaaaaaaa"],
      sedimentIds: ["sediment-1"],
      toolInvoked: true,
      blocked: false
    });
  });

  it("does not treat uploaded user image pointers as generated outputs", () => {
    const text = [
      'data: {"v":{"message":{"author":{"role":"user"},"content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"file-service://file_00000000bbbbbbbbbbbbbbbbbbbbbbbb"}]}},"conversation_id":"conv-1"}}',
      ""
    ].join("\n");

    expect(updateChatGptConversationState(text).fileIds).toEqual([]);
  });

  it("extracts Codex image_generation_call results recursively", () => {
    expect(
      extractCodexImageResults([
        {
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
          }
        }
      ])
    ).toEqual(["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="]);
  });

  it("extracts generated image pointers from full conversation documents", () => {
    expect(
      collectChatGptImagePointers({
        mapping: {
          message1: {
            message: {
              author: { role: "user" },
              content: {
                content_type: "multimodal_text",
                parts: [{ asset_pointer: "file-service://file_00000000bbbbbbbbbbbbbbbbbbbbbbbb" }]
              }
            }
          },
          message2: {
            message: {
              author: { role: "tool" },
              metadata: { async_task_type: "image_gen" },
              content: {
                content_type: "multimodal_text",
                parts: [
                  { asset_pointer: "file-service://file_00000000cccccccccccccccccccccccc" },
                  { asset_pointer: "sediment://sediment-2" }
                ]
              }
            }
          }
        }
      })
    ).toEqual({
      fileIds: ["file_00000000cccccccccccccccccccccccc"],
      sedimentIds: ["sediment-2"]
    });
  });
});

describe("targetRequestForTask", () => {
  it("builds a multipart images edit request when stored input images are present", async () => {
    const r2 = createMockR2Bucket({
      objects: {
        "tasks/device-1/task-1/inputs/0.png": new Uint8Array([1, 2, 3]),
        "tasks/device-1/task-1/mask.png": new Uint8Array([4, 5, 6])
      }
    });
    const task = createTaskRow({
      target_url: "https://api.example/v1/images/generations",
      target_payload: JSON.stringify({
        model: "gpt-image-2",
        prompt: "make it brighter",
        size: "1024x1024",
        quality: "auto",
        __inputImages: [
          {
            key: "tasks/device-1/task-1/inputs/0.png",
            contentType: "image/png",
            size: 3,
            filename: "reference.png"
          }
        ],
        __maskImage: {
          key: "tasks/device-1/task-1/mask.png",
          contentType: "image/png",
          size: 3,
          filename: "mask.png"
        }
      })
    });

    const request = await targetRequestForTask(task, {
      DB: createMockDb(task),
      IMAGES: r2,
      IMAGE_TASK_QUEUE: createMockQueue()
    });

    expect(request.url).toBe("https://api.example/v1/images/edits");
    expect(request.headers.get("Authorization")).toBe("Bearer sk-test");
    expect(request.headers.has("Content-Type")).toBe(false);
    expect(request.body).toBeInstanceOf(FormData);

    const formData = request.body as FormData;
    expect(formData.get("model")).toBe("gpt-image-2");
    expect(formData.get("prompt")).toBe("make it brighter");
    expect(formData.getAll("image[]")).toHaveLength(1);
    expect(formData.get("image[]")).toBeInstanceOf(File);
    expect(formData.get("mask")).toBeInstanceOf(File);
  });
});

describe("POST /tasks source selection", () => {
  it("requires Clerk authentication for task creation", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { prompt: "A clean product render" } })
      }),
      taskEnv(),
      createMockExecutionContext()
    );

    await expect(response.json()).resolves.toEqual({ error: "auth_required" });
    expect(response.status).toBe(401);
  });

  it("creates target-api tasks from Worker env config and the Clerk user id", async () => {
    const db = createMockDb(null);
    const queue = createMockQueue();
    const response = await worker.fetch(
      new Request("https://worker.example/tasks", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          uuid: "forged-device",
          url: "https://client.example/ignored",
          key: "sk-client-ignored",
          modelId: "client-model-ignored",
          payload: {
            model: "client-model-in-payload-ignored",
            prompt: "A clean product render"
          }
        })
      }),
      taskEnv({
        DB: db,
        IMAGE_TASK_QUEUE: queue
      }),
      createMockExecutionContext()
    );

    expect(response.status).toBe(202);
    expect(verifyToken).toHaveBeenCalledWith(
      "clerk-session-token",
      expect.objectContaining({ secretKey: "sk_test_clerk" })
    );
    expect(db.insertedTask).toMatchObject({
      uuid: "user-1",
      target_url: "https://api.example/v1/images/generations",
      target_api_key: "sk-worker",
      api_key_hint: "***rker",
      account_id: null,
      model_id: "gpt-image-2",
      prompt: "A clean product render"
    });
    expect(JSON.parse(db.insertedTask?.target_payload ?? "{}")).toMatchObject({
      model: "gpt-image-2",
      prompt: "A clean product render"
    });
    expect(queue.sentMessages).toHaveLength(1);
  });

  it("creates ChatGPT web-source tasks from Worker source config and the Clerk user id", async () => {
    const db = createMockDb(null);
    const queue = createMockQueue();
    const response = await worker.fetch(
      new Request("https://worker.example/tasks", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          accountId: "account-1",
          url: "https://client-chatgpt.example/ignored",
          targetUrl: "https://client-target.example/ignored",
          key: "chatgpt-client-token-ignored",
          apiKey: "chatgpt-client-api-key-ignored",
          payload: {
            model: "gpt-image-2",
            prompt: "A clean product render"
          }
        })
      }),
      taskEnv({
        DB: db,
        IMAGE_TASK_QUEUE: queue,
        IMAGE_TASK_SOURCE: "chatgpt-web"
      }),
      createMockExecutionContext()
    );

    expect(response.status).toBe(202);
    expect(db.insertedTask).toMatchObject({
      uuid: "user-1",
      target_url: "https://chatgpt.com",
      target_api_key: null,
      api_key_hint: "account-1",
      account_id: "account-1",
      model_id: "gpt-image-2",
      prompt: "A clean product render"
    });
    expect(JSON.parse(db.insertedTask?.target_payload ?? "{}")).toMatchObject({
      __source: "chatgpt-web",
      __accountId: "account-1",
      model: "gpt-image-2",
      prompt: "A clean product render"
    });
    expect(queue.sentMessages).toHaveLength(1);
  });
});

describe("Queue consumer ChatGPT web source", () => {
  it("processes a queued ChatGPT web image task through the existing D1/R2 flow", async () => {
    const imageFileId = "file_00000000dddddddddddddddddddddddd";
    const imageBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url === "https://chatgpt.com/") {
        return new Response('<html data-build="test-build"><script src="/backend-api/sentinel/sdk.js"></script></html>', {
          headers: { "Content-Type": "text/html" }
        });
      }
      if (url.endsWith("/backend-api/sentinel/chat-requirements")) {
        return Response.json({ token: "requirements-token" });
      }
      if (url.endsWith("/backend-api/f/conversation/prepare")) {
        return Response.json({ conduit_token: "conduit-token" });
      }
      if (url.endsWith("/backend-api/f/conversation")) {
        return new Response(
          [
            'data: {"type":"server_ste_metadata","metadata":{"tool_invoked":true},"conversation_id":"conv-1"}',
            "",
            `data: {"v":{"message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"file-service://${imageFileId}"}]}},"conversation_id":"conv-1"}}`,
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      if (url.endsWith(`/backend-api/files/${imageFileId}/download`)) {
        return Response.json({ download_url: "https://download.example/result.png" });
      }
      if (url === "https://download.example/result.png") {
        return new Response(imageBytes, { headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`unexpected fetch:${url}`);
    });

    const row = createTaskRow({
      status: "queued",
      attempts: 0,
      started_at: null,
      completed_at: null,
      target_url: "https://chatgpt.com",
      target_api_key: "chatgpt-access-token",
      target_payload: JSON.stringify({
        __source: "chatgpt-web",
        model: "gpt-image-2",
        prompt: "A clean product render",
        size: "1024x1024",
        quality: "auto"
      })
    });
    const r2 = createMockR2Bucket();
    const message = createMockQueueMessage("task-1");

    await worker.queue(
      {
        messages: [message],
        queue: "image-task-queue",
        retryAll() {
          return;
        },
        ackAll() {
          return;
        }
      } as unknown as MessageBatch<{ taskId: string }>,
      {
        DB: createMockDb(row),
        IMAGES: r2,
        IMAGE_TASK_QUEUE: createMockQueue(),
        DEFAULT_IMAGE_TIMEOUT_SECONDS: "60",
        IMAGE_DOWNLOAD_TIMEOUT_SECONDS: "10"
      }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://download.example/result.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
    expect(row.status).toBe("succeeded");
    expect(row.target_api_key).toBeNull();
    expect(row.result_objects).toBe(JSON.stringify([{ key: "tasks/device-1/task-1/0.png", contentType: "image/png", size: imageBytes.byteLength }]));
    expect(row.result_urls).toBe(JSON.stringify(["/tasks/task-1/images/0"]));
    expect(r2.putObjects).toEqual(["tasks/device-1/task-1/0.png"]);
  });

  it("selects an active account from the pool when the task has no inline token", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 9, 9, 9]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      if (url === "https://chatgpt.com/") {
        return new Response('<html data-build="test-build"><script src="/backend-api/sentinel/sdk.js"></script></html>');
      }
      if (url.endsWith("/backend-api/sentinel/chat-requirements")) {
        expect(headers.get("Authorization")).toBe("Bearer pooled-access-token");
        return Response.json({ token: "requirements-token" });
      }
      if (url.endsWith("/backend-api/codex/responses")) {
        expect(headers.get("Authorization")).toBe("Bearer pooled-access-token");
        return new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="}}',
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      throw new Error(`unexpected fetch:${url}`);
    });

    const row = createTaskRow({
      status: "queued",
      attempts: 0,
      started_at: null,
      completed_at: null,
      target_url: "https://chatgpt.com",
      target_api_key: null,
      api_key_hint: "account-1",
      account_id: "account-1",
      target_payload: JSON.stringify({
        __source: "chatgpt-web",
        __accountId: "account-1",
        model: "codex-gpt-image-2",
        prompt: "A clean product render"
      })
    });
    const account = createAccountRow({ access_token: "pooled-access-token", token_hint: "***oken" });
    const message = createMockQueueMessage("task-1");

    await worker.queue(
      {
        messages: [message],
        queue: "image-task-queue",
        retryAll() {
          return;
        },
        ackAll() {
          return;
        }
      } as unknown as MessageBatch<{ taskId: string }>,
      {
        DB: createMockDb(row, [account]),
        IMAGES: createMockR2Bucket(),
        IMAGE_TASK_QUEUE: createMockQueue(),
        DEFAULT_IMAGE_TIMEOUT_SECONDS: "60",
        IMAGE_DOWNLOAD_TIMEOUT_SECONDS: "10"
      }
    );

    expect(message.acked).toBe(true);
    expect(row.status).toBe("succeeded");
    expect(account.total_uses).toBe(1);
    expect(account.success_count).toBe(1);
    expect(account.failure_count).toBe(0);
    expect(account.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("Account pool API", () => {
  it("serves the built-in account management page", async () => {
    const response = await worker.fetch(new Request("https://worker.example/admin/accounts"), {
      DB: createMockDb(null),
      IMAGES: createMockR2Bucket(),
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("ChatGPT 账号池");
  });

  it("creates, lists, updates and deletes ChatGPT accounts without returning the token", async () => {
    const accounts: MockAccountRow[] = [];
    const db = createMockDb(null, accounts);

    const createResponse = await worker.fetch(
      new Request("https://worker.example/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Main",
          email: "main@example.com",
          accessToken: "chatgpt-access-token",
          quotaRemaining: 12,
          quotaLimit: 20
        })
      }),
      {
        DB: db,
        IMAGES: createMockR2Bucket(),
        IMAGE_TASK_QUEUE: createMockQueue()
      },
      createMockExecutionContext()
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { account: Record<string, unknown> };
    expect(created.account).toMatchObject({
      label: "Main",
      email: "main@example.com",
      tokenHint: "***oken",
      quotaRemaining: 12,
      quotaLimit: 20
    });
    expect(created.account).not.toHaveProperty("access_token");
    expect(created.account).not.toHaveProperty("accessToken");

    const accountId = created.account.id as string;
    const listResponse = await worker.fetch(new Request("https://worker.example/accounts"), {
      DB: db,
      IMAGES: createMockR2Bucket(),
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());
    const listBody = (await listResponse.json()) as { accounts: unknown[] };
    expect(listBody.accounts).toHaveLength(1);

    const updateResponse = await worker.fetch(
      new Request(`https://worker.example/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Backup", status: "inactive", quotaRemaining: 8 })
      }),
      {
        DB: db,
        IMAGES: createMockR2Bucket(),
        IMAGE_TASK_QUEUE: createMockQueue()
      },
      createMockExecutionContext()
    );
    const updated = (await updateResponse.json()) as { account: Record<string, unknown> };
    expect(updated.account).toMatchObject({ label: "Backup", status: "inactive", quotaRemaining: 8 });

    const deleteResponse = await worker.fetch(new Request(`https://worker.example/accounts/${accountId}`, { method: "DELETE" }), {
      DB: db,
      IMAGES: createMockR2Bucket(),
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());
    expect(deleteResponse.status).toBe(200);
    expect(accounts[0].deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("checks account validity and records the result", async () => {
    const account = createAccountRow();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url === "https://chatgpt.com/") {
        return new Response('<html data-build="test-build"><script src="/backend-api/sentinel/sdk.js"></script></html>');
      }
      if (url.endsWith("/backend-api/sentinel/chat-requirements")) {
        return Response.json({ token: "requirements-token" });
      }
      throw new Error(`unexpected fetch:${url}`);
    });

    const response = await worker.fetch(new Request("https://worker.example/accounts/account-1/check", { method: "POST" }), {
      DB: createMockDb(null, [account]),
      IMAGES: createMockR2Bucket(),
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; account: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.account).toMatchObject({ id: "account-1", status: "active", lastError: null });
    expect(account.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("Authenticated task reads", () => {
  it("lists only tasks owned by the Clerk user", async () => {
    const row = createTaskRow({ uuid: "user-1" });
    const response = await worker.fetch(
      new Request("https://worker.example/tasks?uuid=ignored-device&limit=80", { headers: authHeaders() }),
      taskEnv({ DB: createMockDb(row) }),
      createMockExecutionContext()
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: Array<Record<string, unknown>> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      uuid: "user-1",
      userId: "user-1",
      ownerType: "user"
    });
  });

  it("does not stream task images owned by another Clerk user", async () => {
    const row = createTaskRow({
      uuid: "another-user",
      result_objects: JSON.stringify([{ key: "tasks/another-user/task-1/0.png", contentType: "image/png", size: 3 }])
    });
    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1/images/0", { headers: authHeaders() }),
      taskEnv({ DB: createMockDb(row) }),
      createMockExecutionContext()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "task_not_found" });
  });
});

describe("DELETE /tasks/:taskId", () => {
  it("requires Clerk authentication", async () => {
    const response = await worker.fetch(new Request("https://worker.example/tasks/task-1", { method: "DELETE" }), {
      DB: createMockDb(null),
      IMAGES: createMockR2Bucket(),
      CLERK_SECRET_KEY: "sk_test_clerk",
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());

    await expect(response.json()).resolves.toEqual({ error: "auth_required" });
    expect(response.status).toBe(401);
  });

  it("soft deletes the task and removes stored R2 objects", async () => {
    const row = createTaskRow({
      uuid: "user-1",
      result_objects: JSON.stringify([
        { key: "tasks/user-1/task-1/0.png", contentType: "image/png", size: 10 },
        { key: "tasks/user-1/task-1/1.webp", contentType: "image/webp", size: 20 }
      ]),
      result_urls: JSON.stringify(["/tasks/task-1/images/0", "/tasks/task-1/images/1"])
    });
    const r2 = createMockR2Bucket({ deferDelete: true });
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1", { method: "DELETE", headers: authHeaders() }),
      taskEnv({
        DB: createMockDb(row),
        IMAGES: r2
      }),
      ctx
    );

    const body = (await response.json()) as { deleted: boolean; taskId: string; deletedAt: string };
    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.taskId).toBe("task-1");
    expect(body.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.operations).toEqual(["delete_returning"]);
    expect(r2.deletedKeys).toEqual([]);
    expect(row.target_api_key).toBeNull();
    expect(row.target_payload).toBeNull();
    expect(row.result_objects).toBeNull();
    expect(row.result_urls).toBeNull();
    expect(row.deleted_at).toBe(body.deletedAt);
    r2.resolveDelete();
    await ctx.runWaitUntil();
    expect(r2.deletedKeys).toEqual(["tasks/user-1/task-1/0.png", "tasks/user-1/task-1/1.webp"]);
    expect(r2.listedPrefixes).toEqual(["tasks/user-1/task-1/"]);
  });

  it("can clean up task objects by prefix without storing result objects in the delete response path", async () => {
    const row = createTaskRow({
      uuid: "user-1",
      result_objects: null
    });
    const r2 = createMockR2Bucket({
      listedKeys: ["tasks/user-1/task-1/0.png", "tasks/user-1/task-1/1.webp"]
    });
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1", { method: "DELETE", headers: authHeaders() }),
      taskEnv({
        DB: createMockDb(row),
        IMAGES: r2
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(row.operations).toEqual(["delete_returning"]);
    await ctx.runWaitUntil();
    expect(r2.listedPrefixes).toEqual(["tasks/user-1/task-1/"]);
    expect(r2.deletedKeys).toEqual(["tasks/user-1/task-1/0.png", "tasks/user-1/task-1/1.webp"]);
  });

  it("does not delete tasks owned by another Clerk user", async () => {
    const row = createTaskRow({ uuid: "another-user" });
    const r2 = createMockR2Bucket();
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1", { method: "DELETE", headers: authHeaders() }),
      taskEnv({
        DB: createMockDb(row),
        IMAGES: r2
      }),
      ctx
    );

    await expect(response.json()).resolves.toEqual({ error: "task_not_found" });
    expect(response.status).toBe(404);
    expect(r2.deletedKeys).toEqual([]);
    expect(row.deleted_at).toBeNull();
    await ctx.runWaitUntil();
    expect(r2.deletedKeys).toEqual([]);
  });
});

type MockTaskRow = {
  id: string;
  uuid: string;
  status: "queued" | "running" | "succeeded" | "failed";
  target_url: string;
  target_api_key: string | null;
  api_key_hint: string | null;
  account_id: string | null;
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
  operations: string[];
};

type MockAccountRow = {
  id: string;
  label: string;
  email: string | null;
  access_token: string;
  token_hint: string;
  status: "active" | "inactive" | "invalid" | "rate_limited";
  quota_remaining: number | null;
  quota_limit: number | null;
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  total_uses: number;
  success_count: number;
  failure_count: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

function createTaskRow(overrides: Partial<MockTaskRow> = {}): MockTaskRow {
  return {
    id: "task-1",
    uuid: "device-1",
    status: "succeeded",
    target_url: "https://api.example/images",
    target_api_key: "sk-test",
    api_key_hint: "***test",
    account_id: null,
    model_id: "gpt-image-2",
    prompt: "A clean product render",
    target_payload: JSON.stringify({ model: "gpt-image-2", prompt: "A clean product render" }),
    result_objects: null,
    result_urls: null,
    error: null,
    attempts: 1,
    max_attempts: 1,
    created_at: "2026-06-09T00:00:00.000Z",
    queued_at: "2026-06-09T00:00:00.000Z",
    started_at: "2026-06-09T00:00:01.000Z",
    completed_at: "2026-06-09T00:00:02.000Z",
    failed_at: null,
    deleted_at: null,
    updated_at: "2026-06-09T00:00:02.000Z",
    operations: [],
    ...overrides
  };
}

function createAccountRow(overrides: Partial<MockAccountRow> = {}): MockAccountRow {
  return {
    id: "account-1",
    label: "Main account",
    email: "main@example.com",
    access_token: "chatgpt-access-token",
    token_hint: "***oken",
    status: "active",
    quota_remaining: null,
    quota_limit: null,
    last_checked_at: null,
    last_used_at: null,
    last_error: null,
    total_uses: 0,
    success_count: 0,
    failure_count: 0,
    deleted_at: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides
  };
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", "Bearer clerk-session-token");
  return headers;
}

function taskEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockDb(null),
    IMAGES: createMockR2Bucket(),
    IMAGE_TASK_QUEUE: createMockQueue(),
    CLERK_SECRET_KEY: "sk_test_clerk",
    IMAGE_API_URL: "https://api.example/v1/images/generations",
    IMAGE_API_KEY: "sk-worker",
    IMAGE_API_MODEL: "gpt-image-2",
    ...overrides
  };
}

function createMockDb(row: MockTaskRow | null, accounts: MockAccountRow[] = []): D1Database & { insertedTask?: Partial<MockTaskRow>; insertedAccount?: Partial<MockAccountRow> } {
  const dbState: { insertedTask?: Partial<MockTaskRow>; insertedAccount?: Partial<MockAccountRow> } = {};
  return {
    get insertedTask() {
      return dbState.insertedTask;
    },
    get insertedAccount() {
      return dbState.insertedAccount;
    },
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              const currentRow = row;
              if (sql.includes("SELECT COUNT(*) AS count FROM chatgpt_accounts")) {
                return { count: accounts.filter((account) => !account.deleted_at).length };
              }
              if (sql.includes("SELECT * FROM chatgpt_accounts WHERE id = ?")) {
                return accounts.find((account) => account.id === values[0] && !account.deleted_at) ?? null;
              }
              if (sql.includes("SELECT * FROM chatgpt_accounts") && sql.includes("status = 'active'")) {
                return accounts.find((account) => account.status === "active" && !account.deleted_at && (account.quota_remaining === null || account.quota_remaining > 0)) ?? null;
              }
              if (sql.includes("RETURNING id AS taskId")) {
                if (!currentRow || currentRow.id !== values[2]) {
                  return null;
                }

                const ownerId = values[3];
                if (currentRow.deleted_at || currentRow.uuid !== ownerId) {
                  return null;
                }

                const resultObjects = currentRow.result_objects;
                currentRow.target_api_key = null;
                currentRow.target_payload = null;
                currentRow.result_objects = null;
                currentRow.result_urls = null;
                currentRow.deleted_at = values[0] as string;
                currentRow.updated_at = values[1] as string;
                currentRow.operations.push("delete_returning");

                return {
                  taskId: currentRow.id,
                  uuid: currentRow.uuid,
                  resultObjects,
                  deletedAt: currentRow.deleted_at
                };
              }

              if (sql.includes("SELECT * FROM image_tasks WHERE id = ?") && currentRow?.id === values[0]) {
                return currentRow;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM chatgpt_accounts")) {
                return { results: accounts.filter((account) => !account.deleted_at), success: true, meta: {} };
              }
              return { results: row ? [row] : [], success: true, meta: {} };
            },
            async run() {
              if (sql.includes("INSERT INTO image_tasks")) {
                dbState.insertedTask = {
                  id: values[0] as string,
                  uuid: values[1] as string,
                  target_url: values[2] as string,
                  target_api_key: values[3] as string,
                  api_key_hint: values[4] as string,
                  account_id: values[5] as string | null,
                  model_id: values[6] as string,
                  prompt: values[7] as string,
                  target_payload: values[8] as string,
                  max_attempts: values[9] as number,
                  created_at: values[10] as string,
                  queued_at: values[11] as string,
                  updated_at: values[12] as string
                };
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO chatgpt_accounts")) {
                const account = createAccountRow({
                  id: values[0] as string,
                  label: values[1] as string,
                  email: values[2] as string | null,
                  access_token: values[3] as string,
                  token_hint: values[4] as string,
                  status: values[5] as MockAccountRow["status"],
                  quota_remaining: values[6] as number | null,
                  quota_limit: values[7] as number | null,
                  created_at: values[8] as string,
                  updated_at: values[9] as string
                });
                accounts.push(account);
                dbState.insertedAccount = account;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'running'") && row) {
                row.status = "running";
                row.attempts = values[0] as number;
                row.started_at = row.started_at ?? (values[1] as string);
                row.updated_at = values[2] as string;
                row.error = null;
                row.operations.push("running_update");
                return { success: true, meta: { changes: row.id === values[3] && !row.deleted_at ? 1 : 0 } };
              }
              if (sql.includes("SET status = 'succeeded'") && row) {
                row.status = "succeeded";
                row.target_api_key = null;
                row.result_objects = values[0] as string;
                row.result_urls = values[1] as string;
                row.completed_at = values[2] as string;
                row.updated_at = values[3] as string;
                row.error = null;
                row.operations.push("success_update");
                return { success: true, meta: { changes: row.id === values[4] && !row.deleted_at ? 1 : 0 } };
              }
              if (sql.includes("SET last_used_at = ?")) {
                const account = accounts.find((item) => item.id === values[2] && !item.deleted_at);
                if (!account) return { success: true, meta: { changes: 0 } };
                account.last_used_at = values[0] as string;
                account.total_uses += 1;
                account.updated_at = values[1] as string;
                if (account.quota_remaining !== null && account.quota_remaining > 0) account.quota_remaining -= 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET success_count = success_count")) {
                const account = accounts.find((item) => item.id === values[9] && !item.deleted_at);
                if (!account) return { success: true, meta: { changes: 0 } };
                account.success_count += values[0] as number;
                account.failure_count += values[1] as number;
                account.last_error = values[7] as string | null;
                account.updated_at = values[8] as string;
                if (values[2] === 1) account.status = "active";
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET label = ?")) {
                const account = accounts.find((item) => item.id === values[8] && !item.deleted_at);
                if (!account) return { success: true, meta: { changes: 0 } };
                account.label = values[0] as string;
                account.email = values[1] as string | null;
                account.access_token = (values[2] as string | null) ?? account.access_token;
                account.token_hint = (values[3] as string | null) ?? account.token_hint;
                account.status = values[4] as MockAccountRow["status"];
                account.quota_remaining = values[5] as number | null;
                account.quota_limit = values[6] as number | null;
                account.updated_at = values[7] as string;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET deleted_at = ?") && sql.includes("chatgpt_accounts")) {
                const account = accounts.find((item) => item.id === values[2] && !item.deleted_at);
                if (!account) return { success: true, meta: { changes: 0 } };
                account.deleted_at = values[0] as string;
                account.updated_at = values[1] as string;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET status = ?") && sql.includes("last_checked_at")) {
                const account = accounts.find((item) => item.id === values[4] && !item.deleted_at);
                if (!account) return { success: true, meta: { changes: 0 } };
                account.status = values[0] as MockAccountRow["status"];
                account.last_checked_at = values[1] as string;
                account.last_error = values[2] as string | null;
                account.updated_at = values[3] as string;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("SET target_api_key = NULL") && sql.includes("deleted_at = ?") && row) {
                row.target_api_key = null;
                row.target_payload = null;
                row.result_objects = null;
                row.result_urls = null;
                row.deleted_at = values[0] as string;
                row.updated_at = values[1] as string;
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
          };
        }
      };
    }
  } as unknown as D1Database & { insertedTask?: Partial<MockTaskRow> };
}

function createMockQueueMessage(taskId: string): Message<{ taskId: string }> & { acked: boolean; retried: boolean } {
  const message = {
    id: "message-1",
    timestamp: new Date(),
    body: { taskId },
    attempts: 1,
    acked: false,
    retried: false,
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    }
  } as unknown as Message<{ taskId: string }> & { acked: boolean; retried: boolean };
  return message;
}

function createMockR2Bucket(options: { deferDelete?: boolean; listedKeys?: string[]; objects?: Record<string, Uint8Array> } = {}): R2Bucket & {
  deletedKeys: string[];
  listedPrefixes: string[];
  putObjects: string[];
  resolveDelete: () => void;
} {
  const deletedKeys: string[] = [];
  const listedPrefixes: string[] = [];
  const putObjects: string[] = [];
  let resolveDelete: () => void = () => undefined;
  return {
    deletedKeys,
    listedPrefixes,
    putObjects,
    async get(key: string) {
      const bytes = options.objects?.[key];
      if (!bytes) return null;
      const copy = new Uint8Array(bytes);
      return new Response(new Blob([copy.buffer], { type: "image/png" }), {
        headers: {
          "Content-Type": "image/png"
        }
      });
    },
    async put(key: string) {
      putObjects.push(key);
      return;
    },
    async delete(keys: string | string[]) {
      if (options.deferDelete) {
        await new Promise<void>((resolve) => {
          resolveDelete = resolve;
        });
      }
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
    async list(params?: R2ListOptions) {
      listedPrefixes.push(params?.prefix ?? "");
      return {
        objects: (options.listedKeys ?? [])
          .filter((key) => !params?.prefix || key.startsWith(params.prefix))
          .map((key) => ({ key })),
        truncated: false
      };
    },
    resolveDelete() {
      resolveDelete();
    }
  } as unknown as R2Bucket & { deletedKeys: string[]; listedPrefixes: string[]; putObjects: string[]; resolveDelete: () => void };
}

function createMockQueue(): Queue<{ taskId: string }> & { sentMessages: { taskId: string }[] } {
  const sentMessages: { taskId: string }[] = [];
  return {
    sentMessages,
    async send(message: { taskId: string }) {
      sentMessages.push(message);
      return;
    }
  } as unknown as Queue<{ taskId: string }> & { sentMessages: { taskId: string }[] };
}

function createMockExecutionContext(): ExecutionContext & { runWaitUntil: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  return {
    props: {},
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
    passThroughOnException() {
      return;
    },
    async runWaitUntil() {
      await Promise.all(tasks);
    }
  };
}
