import { byteLength, HttpError, parseBoundedInteger } from "./core";
import { extensionForContentType, imageFromDataUrl } from "./image-codecs";
import { optionalStringField, stringField } from "./input-validation";
import type {
  AuthContext,
  CreateTaskRequest,
  Env,
  ImageTaskSource,
  NormalizedCreateTaskRequest,
  NormalizedInputImage
} from "./types";

const MAX_TARGET_PAYLOAD_BYTES = 256 * 1024;
const MAX_INPUT_IMAGES = 16;
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;

export const CHATGPT_WEB_SOURCE = "chatgpt-web";

export function validateCreateTask(input: CreateTaskRequest, env: Env, auth: AuthContext): NormalizedCreateTaskRequest {
  const source = normalizeTaskSource(env.IMAGE_TASK_SOURCE ?? input.source);
  const targetUrl =
    source === "chatgpt-web"
      ? chatGptBaseUrl(env)
      : stringField(env.IMAGE_API_URL, "image_api_url", 2048);
  const apiKey =
    source === "chatgpt-web"
      ? null
      : stringField(env.IMAGE_API_KEY, "image_api_key", 4096);
  const accountId = source === "chatgpt-web" ? optionalStringField(input.accountId, 128) ?? null : null;
  const explicitPayload = normalizeTargetPayload(input.payload);
  const inputImages = normalizeInputImages(input.inputImages);
  const mask = normalizeMaskImage(input.mask);
  if (mask && inputImages.length === 0) {
    throw new HttpError(400, "mask_requires_input_image");
  }
  const modelId =
    optionalStringField(env.IMAGE_API_MODEL, 256) ??
    (source === "chatgpt-web" ? optionalStringField(input.modelId ?? input.modelid, 256) : undefined) ??
    optionalStringField(explicitPayload?.model, 256) ??
    (explicitPayload ? "gpt-image-2" : stringField(undefined, "modelid", 256));
  const prompt =
    optionalStringField(input.prompt, 20000) ??
    optionalStringField(explicitPayload?.prompt, 20000) ??
    (explicitPayload ? "" : stringField(undefined, "prompt", 20000));
  const targetPayload = stringifyTargetPayload({
    ...(explicitPayload ?? {}),
    model: modelId,
    prompt
  });
  const uuid = auth.userId;
  const maxAttempts = parseBoundedInteger(
    input.maxAttempts === undefined ? env.MAX_ATTEMPTS : String(input.maxAttempts),
    3,
    1,
    10
  );

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "https:" && (source !== "target-api" || parsed.protocol !== "http:")) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new HttpError(400, "invalid_target_url");
  }

  return {
    targetUrl,
    apiKey,
    accountId,
    modelId,
    prompt,
    targetPayload,
    inputImages,
    mask,
    uuid,
    maxAttempts,
    source
  };
}

export function normalizeTaskSource(value: unknown): ImageTaskSource {
  const raw = optionalStringField(value, 64);
  if (!raw || raw === "target-api" || raw === "openai-compatible") return "target-api";
  if (raw === CHATGPT_WEB_SOURCE || raw === "chatgpt" || raw === "chatgpt-web-image") return "chatgpt-web";
  throw new HttpError(400, "invalid_source");
}

export function normalizeTargetPayload(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "payload_object_required");
  }

  return value as Record<string, unknown>;
}

export function normalizeInputImages(value: unknown): NormalizedInputImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "input_images_array_required");
  }
  if (value.length > MAX_INPUT_IMAGES) {
    throw new HttpError(400, "too_many_input_images");
  }

  return value.map((item, index) => normalizeInputImage(item, index));
}

export function normalizeInputImage(value: unknown, index: number): NormalizedInputImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "input_image_object_required");
  }

  const record = value as Record<string, unknown>;
  const dataUrl = stringField(record.dataUrl, "input_image_data_url", MAX_INPUT_IMAGE_BYTES * 2);
  const image = imageFromDataUrl(dataUrl);
  if (image.bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new HttpError(400, "input_image_too_large");
  }

  const fallbackName = `input-${index + 1}.${extensionForContentType(image.contentType)}`;
  return {
    ...image,
    filename: optionalStringField(record.filename, 160) ?? fallbackName
  };
}

export function normalizeMaskImage(value: unknown): NormalizedInputImage | null {
  if (value === undefined || value === null) return null;
  const image = normalizeInputImage(value, 0);
  if (image.contentType !== "image/png") {
    throw new HttpError(400, "mask_png_required");
  }
  return {
    ...image,
    filename: "mask.png"
  };
}

export function stringifyTargetPayload(payload: Record<string, unknown>): string {
  const jsonPayload = JSON.stringify(payload);
  if (byteLength(jsonPayload) > MAX_TARGET_PAYLOAD_BYTES) {
    throw new HttpError(400, "payload_too_large");
  }
  return jsonPayload;
}

function chatGptBaseUrl(env: Env): string {
  return (env.CHATGPT_BASE_URL || "https://chatgpt.com").replace(/\/+$/, "");
}
