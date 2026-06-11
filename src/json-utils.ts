import type { StoredInputImageObject } from "./types";

export function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseStoredInputImageObjects(value: unknown): StoredInputImageObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = parseStoredInputImageObject(item);
    return object ? [object] : [];
  });
}

export function parseStoredInputImageObject(value: unknown): StoredInputImageObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || typeof record.contentType !== "string") return null;
  return {
    key: record.key,
    contentType: record.contentType,
    size: typeof record.size === "number" ? record.size : 0,
    filename: typeof record.filename === "string" ? record.filename : "input.png"
  };
}
