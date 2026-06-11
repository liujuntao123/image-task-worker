import { sha3_512 } from "js-sha3";
import { optionalStringField } from "./input-validation";

export interface ChatGptConversationState {
  conversationId: string;
  fileIds: string[];
  sedimentIds: string[];
  toolInvoked: boolean | null;
  blocked: boolean;
}

export function parseSseJsonEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const flush = () => {
    const payload = lines.join("\n").trim();
    lines.length = 0;
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed upstream event chunks. The final missing-image error is clearer.
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      lines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

export function updateChatGptConversationState(text: string): ChatGptConversationState {
  const state: ChatGptConversationState = {
    conversationId: "",
    fileIds: [],
    sedimentIds: [],
    toolInvoked: null,
    blocked: false
  };

  for (const event of parseSseJsonEvents(text)) {
    const payload = JSON.stringify(event);
    const conversationId = firstMatch(payload, /"conversation_id"\s*:\s*"([^"]+)"/);
    if (conversationId && !state.conversationId) state.conversationId = conversationId;

    const value = objectField(event.v);
    const eventConversationId =
      optionalStringField(event.conversation_id, 256) ?? optionalStringField(value?.conversation_id, 256);
    if (eventConversationId) state.conversationId = eventConversationId;

    if (event.type === "moderation" && objectField(event.moderation_response)?.blocked === true) {
      state.blocked = true;
    }
    if (event.type === "server_ste_metadata") {
      const metadata = objectField(event.metadata);
      if (typeof metadata?.tool_invoked === "boolean") state.toolInvoked = metadata.tool_invoked;
    }

    const isUserMessage = isChatGptUserMessageEvent(event);
    const imageContext =
      isChatGptImageToolEvent(event) ||
      (state.toolInvoked === true && !isUserMessage) ||
      (event.o === "patch" && !isUserMessage && (payload.includes("asset_pointer") || payload.includes("file-service://")));

    if (imageContext) {
      addUnique(state.fileIds, extractAll(payload, /file-service:\/\/([A-Za-z0-9_-]+)/g));
      addUnique(state.fileIds, extractAll(payload, /\b(file_00000000[a-f0-9]{24})\b/g));
      addUnique(state.sedimentIds, extractAll(payload, /sediment:\/\/([A-Za-z0-9_-]+)/g));
    }
  }

  return state;
}

export function extractCodexImageResults(value: unknown): string[] {
  const images: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (record.type === "image_generation_call" && typeof record.result === "string" && record.result) {
      images.push(record.result);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return Array.from(new Set(images));
}

export function collectChatGptImagePointers(value: unknown): { fileIds: string[]; sedimentIds: string[] } {
  const fileIds: string[] = [];
  const sedimentIds: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const record = objectField(item);
    if (!record) return;

    if (isChatGptImageMessage(record)) {
      const text = JSON.stringify(record);
      addUnique(fileIds, extractAll(text, /file-service:\/\/([A-Za-z0-9_-]+)/g));
      addUnique(fileIds, extractAll(text, /\b(file_00000000[a-f0-9]{24})\b/g));
      addUnique(sedimentIds, extractAll(text, /sediment:\/\/([A-Za-z0-9_-]+)/g));
    }

    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return { fileIds, sedimentIds };
}

export function extractPowScriptSources(html: string): string[] {
  const matches = Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)).map((match) => match[1]);
  return matches.length > 0 ? matches : ["/backend-api/sentinel/sdk.js"];
}

export function extractPowDataBuild(html: string): string {
  const scriptBuild = firstMatch(html, /c\/[^/]*\/_/);
  if (scriptBuild) return scriptBuild;
  return firstMatch(html, /<html[^>]*data-build=["']([^"']*)["']/i) ?? "";
}

export function buildLegacyRequirementsToken(userAgent: string, scriptSources: string[], dataBuild: string): string {
  const seed = String(Math.random());
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  return `gAAAAAC${solvePow(seed, "0fffff", config)}`;
}

export function buildProofToken(
  seed: string,
  difficulty: string,
  userAgent: string,
  scriptSources: string[],
  dataBuild: string
): string {
  return `gAAAAAB${solvePow(seed, difficulty, buildPowConfig(userAgent, scriptSources, dataBuild))}`;
}

function buildPowConfig(userAgent: string, scriptSources: string[], dataBuild: string): unknown[] {
  const now = new Date();
  const eastern = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const parseTime = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][eastern.getUTCDay()]} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][eastern.getUTCMonth()]
  } ${String(eastern.getUTCDate()).padStart(2, "0")} ${eastern.getUTCFullYear()} ${String(eastern.getUTCHours()).padStart(2, "0")}:${String(eastern.getUTCMinutes()).padStart(2, "0")}:${String(eastern.getUTCSeconds()).padStart(2, "0")} GMT-0500 (Eastern Standard Time)`;

  return [
    3000,
    parseTime,
    4294705152,
    0,
    userAgent,
    scriptSources[0] ?? "/backend-api/sentinel/sdk.js",
    dataBuild,
    "en-US",
    "en-US,es-US,en,es",
    0,
    "webdriver−false",
    "location",
    "window",
    Date.now(),
    crypto.randomUUID(),
    "",
    16,
    Date.now()
  ];
}

function solvePow(seed: string, difficulty: string, config: unknown[], limit = 500000): string {
  const target = hexToBytes(difficulty);
  const diffLen = Math.floor(difficulty.length / 2);
  const static1 = `${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`;
  const static2 = `,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`;
  const static3 = `,${JSON.stringify(config.slice(10)).slice(1)}`;
  for (let i = 0; i < limit; i += 1) {
    const candidate = `${static1}${i}${static2}${i >> 1}${static3}`;
    const encoded = btoa(unescape(encodeURIComponent(candidate)));
    const digest = new Uint8Array(sha3_512.arrayBuffer(`${seed}${encoded}`));
    if (compareBytes(digest.slice(0, diffLen), target.slice(0, diffLen)) <= 0) {
      return encoded;
    }
  }
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${btoa(JSON.stringify(seed))}`;
}

function isChatGptImageToolEvent(event: Record<string, unknown>): boolean {
  const value = objectField(event.v);
  const message = objectField(event.message) ?? objectField(value?.message);
  return message ? isChatGptImageMessage(message) : false;
}

function isChatGptImageMessage(message: Record<string, unknown>): boolean {
  const metadata = objectField(message.metadata);
  const author = objectField(message.author);
  const content = objectField(message.content);
  if (author?.role !== "tool") return false;
  if (metadata?.async_task_type === "image_gen") return true;
  if (content?.content_type !== "multimodal_text") return false;
  return Array.isArray(content.parts) && content.parts.some((part) => {
    const record = objectField(part);
    return (
      record?.content_type === "image_asset_pointer" ||
      (typeof record?.asset_pointer === "string" &&
        (record.asset_pointer.startsWith("file-service://") || record.asset_pointer.startsWith("sediment://")))
    );
  });
}

function isChatGptUserMessageEvent(event: Record<string, unknown>): boolean {
  const value = objectField(event.v);
  const message = objectField(event.message) ?? objectField(value?.message);
  const author = objectField(message?.author);
  return String(author?.role ?? "").toLowerCase() === "user";
}

export function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function addUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

export function extractAll(value: string, pattern: RegExp): string[] {
  return Array.from(value.matchAll(pattern)).map((match) => match[1]).filter(Boolean);
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1] ?? value.match(pattern)?.[0];
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
