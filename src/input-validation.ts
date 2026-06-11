import { HttpError } from "./core";

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${name}_required`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name}_too_long`);
  }

  return trimmed;
}

export function optionalStringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    throw new HttpError(400, "field_too_long");
  }

  return trimmed;
}

export function optionalNullableInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "invalid_integer_field");
  }
  return parsed;
}
