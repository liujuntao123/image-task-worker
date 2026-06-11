import { errorMessage, truncate } from "./core";
import { extensionForContentType } from "./image-codecs";
import { parseJsonArray, parseJsonObject, parseStoredInputImageObjects } from "./json-utils";
import { stringifyTargetPayload } from "./task-normalizer";
import type {
  DeletedTaskCleanupTarget,
  Env,
  ImageTaskRow,
  ImageTaskSource,
  NormalizedImage,
  NormalizedInputImage,
  StoredImageObject,
  StoredInputImageObject
} from "./types";

export type TaskEventLogger = (event: string, details: Record<string, unknown>) => void;

export async function storeImages(task: ImageTaskRow, images: NormalizedImage[], env: Env): Promise<StoredImageObject[]> {
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

export async function storeInputImages(
  taskId: string,
  uuid: string,
  images: NormalizedInputImage[],
  env: Env
): Promise<StoredInputImageObject[]> {
  const stored: StoredInputImageObject[] = [];

  for (const [index, image] of images.entries()) {
    const extension = extensionForContentType(image.contentType);
    const key = `tasks/${uuid}/${taskId}/inputs/${index}.${extension}`;
    await env.IMAGES.put(key, image.bytes, {
      httpMetadata: {
        contentType: image.contentType
      },
      customMetadata: {
        taskId,
        uuid,
        source: "input"
      }
    });

    stored.push({
      key,
      contentType: image.contentType,
      size: image.bytes.byteLength,
      filename: image.filename || `input-${index + 1}.${extension}`
    });
  }

  return stored;
}

export async function storeMaskImage(
  taskId: string,
  uuid: string,
  image: NormalizedInputImage,
  env: Env
): Promise<StoredInputImageObject> {
  const key = `tasks/${uuid}/${taskId}/mask.png`;
  await env.IMAGES.put(key, image.bytes, {
    httpMetadata: {
      contentType: "image/png"
    },
    customMetadata: {
      taskId,
      uuid,
      source: "mask"
    }
  });

  return {
    key,
    contentType: "image/png",
    size: image.bytes.byteLength,
    filename: "mask.png"
  };
}

export function buildStoredTargetPayload(
  targetPayload: string,
  inputObjects: StoredInputImageObject[],
  maskObject: StoredInputImageObject | null,
  source: ImageTaskSource,
  accountId?: string | null
): string {
  if (inputObjects.length === 0 && !maskObject && source === "target-api" && !accountId) return targetPayload;
  const payload = parseJsonObject(targetPayload);
  if (!payload) return targetPayload;
  return stringifyTargetPayload({
    ...payload,
    ...(inputObjects.length > 0 ? { __inputImages: inputObjects } : {}),
    ...(maskObject ? { __maskImage: maskObject } : {}),
    ...(source === "chatgpt-web" ? { __source: source } : {}),
    ...(accountId ? { __accountId: accountId } : {})
  });
}

export function resultUrlsFor(task: ImageTaskRow, objects: StoredImageObject[], env: Env): string[] {
  const publicBaseUrl = (env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (publicBaseUrl) {
    return objects.map((object) => `${publicBaseUrl}/${object.key}`);
  }

  return objects.map((_, index) => `/tasks/${task.id}/images/${index}`);
}

export async function selectTask(taskId: string, env: Env): Promise<ImageTaskRow | null> {
  return env.DB.prepare("SELECT * FROM image_tasks WHERE id = ?").bind(taskId).first<ImageTaskRow>();
}

export async function deleteStoredObjects(objects: StoredImageObject[], env: Env): Promise<number> {
  if (objects.length === 0) return 0;
  await env.IMAGES.delete(objects.map((object) => object.key));
  return objects.length;
}

export async function cleanupDeletedTaskObjects(
  target: DeletedTaskCleanupTarget,
  env: Env,
  logTaskEvent: TaskEventLogger
): Promise<void> {
  const outputObjects = parseJsonArray<StoredImageObject>(target.resultObjects);
  const inputObjects = parseStoredInputImageObjects(parseJsonObject(target.targetPayload)?.__inputImages);
  const objects = [
    ...outputObjects,
    ...inputObjects.map((object) => ({
      key: object.key,
      contentType: object.contentType,
      size: object.size
    }))
  ];
  try {
    const deletedKnownObjects = objects.length > 0 ? await deleteStoredObjects(objects, env) : 0;
    const deletedPrefixObjects = await deleteStoredObjectsByTaskPrefix(target.uuid, target.taskId, env);
    const deletedObjects = deletedKnownObjects + deletedPrefixObjects;

    logTaskEvent("image_task_deleted_objects_cleaned", {
      taskId: target.taskId,
      uuid: target.uuid,
      deletedObjects,
      cleanupMode: cleanupModeFor(target)
    });
  } catch (error) {
    logTaskEvent("image_task_deleted_objects_cleanup_error", {
      taskId: target.taskId,
      uuid: target.uuid,
      deletedObjects: objects.length,
      cleanupMode: cleanupModeFor(target),
      error: truncate(errorMessage(error), 1000)
    });
  }
}

export function cleanupModeFor(target: DeletedTaskCleanupTarget): "stored_objects" | "prefix_scan" {
  return target.resultObjects ? "stored_objects" : "prefix_scan";
}

async function deleteStoredObjectsByTaskPrefix(uuid: string, taskId: string, env: Env): Promise<number> {
  const prefix = `tasks/${uuid}/${taskId}/`;
  let cursor: string | undefined;
  let deletedCount = 0;

  do {
    const listed = await env.IMAGES.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) {
      await env.IMAGES.delete(keys);
      deletedCount += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deletedCount;
}
