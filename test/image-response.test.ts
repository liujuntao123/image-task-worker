import { describe, expect, it } from "vitest";
import worker, { extractImageReferences, parseImageApiResponse, targetRequestBodyForTask } from "../src/index";

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

describe("DELETE /tasks/:taskId", () => {
  it("requires a uuid filter", async () => {
    const response = await worker.fetch(new Request("https://worker.example/tasks/task-1", { method: "DELETE" }), {
      DB: createMockDb(null),
      IMAGES: createMockR2Bucket(),
      IMAGE_TASK_QUEUE: createMockQueue()
    }, createMockExecutionContext());

    await expect(response.json()).resolves.toEqual({ error: "uuid_required" });
    expect(response.status).toBe(400);
  });

  it("soft deletes the task and removes stored R2 objects", async () => {
    const row = createTaskRow({
      result_objects: JSON.stringify([
        { key: "tasks/device-1/task-1/0.png", contentType: "image/png", size: 10 },
        { key: "tasks/device-1/task-1/1.webp", contentType: "image/webp", size: 20 }
      ]),
      result_urls: JSON.stringify(["/tasks/task-1/images/0", "/tasks/task-1/images/1"])
    });
    const r2 = createMockR2Bucket({ deferDelete: true });
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1?uuid=device-1", { method: "DELETE" }),
      {
        DB: createMockDb(row),
        IMAGES: r2,
        IMAGE_TASK_QUEUE: createMockQueue()
      },
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
    expect(r2.deletedKeys).toEqual(["tasks/device-1/task-1/0.png", "tasks/device-1/task-1/1.webp"]);
  });

  it("can clean up task objects by prefix without storing result objects in the delete response path", async () => {
    const row = createTaskRow({
      result_objects: null
    });
    const r2 = createMockR2Bucket({
      listedKeys: ["tasks/device-1/task-1/0.png", "tasks/device-1/task-1/1.webp"]
    });
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1?uuid=device-1", { method: "DELETE" }),
      {
        DB: createMockDb(row),
        IMAGES: r2,
        IMAGE_TASK_QUEUE: createMockQueue()
      },
      ctx
    );

    expect(response.status).toBe(200);
    expect(row.operations).toEqual(["delete_returning"]);
    await ctx.runWaitUntil();
    expect(r2.listedPrefixes).toEqual(["tasks/device-1/task-1/"]);
    expect(r2.deletedKeys).toEqual(["tasks/device-1/task-1/0.png", "tasks/device-1/task-1/1.webp"]);
  });

  it("does not delete tasks owned by another uuid", async () => {
    const row = createTaskRow();
    const r2 = createMockR2Bucket();
    const ctx = createMockExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/tasks/task-1?uuid=another-device", { method: "DELETE" }),
      {
        DB: createMockDb(row),
        IMAGES: r2,
        IMAGE_TASK_QUEUE: createMockQueue()
      },
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

function createTaskRow(overrides: Partial<MockTaskRow> = {}): MockTaskRow {
  return {
    id: "task-1",
    uuid: "device-1",
    status: "succeeded",
    target_url: "https://api.example/images",
    target_api_key: "sk-test",
    api_key_hint: "***test",
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

function createMockDb(row: MockTaskRow | null): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              const currentRow = row;
              if (sql.includes("RETURNING id AS taskId")) {
                if (!currentRow || currentRow.id !== values[2]) {
                  return null;
                }

                const uuids = values.slice(3);
                if (currentRow.deleted_at || !uuids.includes(currentRow.uuid)) {
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
              return { results: row ? [row] : [], success: true, meta: {} };
            },
            async run() {
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
  } as unknown as D1Database;
}

function createMockR2Bucket(options: { deferDelete?: boolean; listedKeys?: string[] } = {}): R2Bucket & {
  deletedKeys: string[];
  listedPrefixes: string[];
  resolveDelete: () => void;
} {
  const deletedKeys: string[] = [];
  const listedPrefixes: string[] = [];
  let resolveDelete: () => void = () => undefined;
  return {
    deletedKeys,
    listedPrefixes,
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
  } as unknown as R2Bucket & { deletedKeys: string[]; listedPrefixes: string[]; resolveDelete: () => void };
}

function createMockQueue(): Queue<{ taskId: string }> {
  return {
    async send() {
      return;
    }
  } as unknown as Queue<{ taskId: string }>;
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
