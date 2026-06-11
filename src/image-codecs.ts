import { fetchWithTimeout, HttpError, parseBoundedInteger } from "./core";
import type { Env, NormalizedImage } from "./types";

export async function parseImageApiResponse(response: Response, env?: Env): Promise<NormalizedImage[]> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("image/")) {
    return [
      {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: normalizeImageContentType(contentType)
      }
    ];
  }

  const jsonBody = (await response.json()) as unknown;
  const refs = extractImageReferences(jsonBody);
  if (refs.length === 0) {
    throw new Error("target_response_missing_image");
  }

  const images: NormalizedImage[] = [];
  for (const ref of refs) {
    images.push(await imageFromReference(ref, env));
  }
  return images;
}

export function extractImageReferences(value: unknown): string[] {
  const refs: string[] = [];

  if (typeof value === "string") {
    if (looksLikeImageReference(value)) refs.push(value);
    return refs;
  }

  if (!value || typeof value !== "object") {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) refs.push(...extractImageReferences(item));
    return refs;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["b64_json", "url", "image_url", "image", "output"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && looksLikeImageReference(candidate)) {
      refs.push(candidate);
    }
  }

  for (const key of ["data", "images", "output", "result"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      refs.push(...extractImageReferences(nested));
    }
  }

  return Array.from(new Set(refs));
}

export async function imageFromReference(ref: string, env?: Env): Promise<NormalizedImage> {
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    const timeoutMs = parseBoundedInteger(env?.IMAGE_DOWNLOAD_TIMEOUT_SECONDS, 120, 10, 900) * 1000;
    const imageResponse = await fetchWithTimeout(ref, {}, timeoutMs);
    if (!imageResponse.ok) {
      throw new Error(`image_download_error:${imageResponse.status}`);
    }

    const contentType = normalizeImageContentType(imageResponse.headers.get("content-type") ?? "");
    return {
      bytes: new Uint8Array(await imageResponse.arrayBuffer()),
      contentType
    };
  }

  if (ref.startsWith("data:")) {
    return imageFromDataUrl(ref);
  }

  return {
    bytes: base64ToBytes(ref),
    contentType: "image/png"
  };
}

export function imageFromDataUrl(value: string): NormalizedImage {
  const match = value.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) {
    throw new HttpError(400, "invalid_data_url_image");
  }

  return {
    bytes: base64ToBytes(match[2]),
    contentType: normalizeImageContentType(match[1] ?? "image/png")
  };
}

export function looksLikeImageReference(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:image/") ||
    looksLikeBase64Image(value)
  );
}

export function looksLikeBase64Image(value: string): boolean {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return false;
  }

  return compact.startsWith("iVBORw0KGgo") || compact.startsWith("/9j/") || compact.startsWith("UklGR");
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function normalizeImageContentType(value: string): string {
  const contentType = value.split(";")[0].trim().toLowerCase();
  if (contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp") {
    return contentType;
  }
  return "image/png";
}

export function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}
