import { verifyToken } from "@clerk/backend";
import type { AuthContext, Env } from "./types";

export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const token = bearerToken(request);
  if (!token) {
    throw new AuthError(401, "auth_required");
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    throw new AuthError(500, "clerk_not_configured");
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: csvEnv(env.CLERK_AUTHORIZED_PARTIES)
    });
    const userId = optionalStringField(payload.sub, 256);
    if (!userId) {
      throw new AuthError(401, "invalid_auth_token");
    }
    return { userId };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(401, "invalid_auth_token");
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function csvEnv(value: string | undefined): string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function optionalStringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    return undefined;
  }

  return trimmed;
}
