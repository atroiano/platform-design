// The only module that talks to the server. Every type here is generated
// from the backend's OpenAPI document (npm run generate); none is hand-written.
import createClient, { type Middleware } from "openapi-fetch";

import { t, tMaybe } from "../i18n";
import type { components, paths } from "./schema";

type Schemas = components["schemas"];
export type Account = Schemas["AccountOut"];
export type PaymentLine = Schemas["PaymentLineOut"];
export type PaymentReceipt = Schemas["PaymentReceiptOut"];
export type PaymentSummary = Schemas["PaymentSummaryOut"];
export type AccountEvent = Schemas["EventOut"];
export type BucketDefinition = Schemas["BucketDefinitionOut"];
export type Health = Schemas["HealthOut"];
export type PlaceAccountCommand = Schemas["PlaceAccount"];
export type PostPaymentCommand = Schemas["PostPayment"];

const STORAGE_KEY = "hivear.development-key";
export const SIGNED_OUT_EVENT = "hivear:signed-out";
const REQUEST_TIMEOUT_MS = 20_000;
let keyInMemory: string | null = null;

// The key lives for the browser tab, not on disk beyond it. Real sign-in
// replaces all of this (WAX-0017).
export function readKey(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? keyInMemory;
  } catch {
    return keyInMemory;
  }
}

export function writeKey(key: string | null): void {
  keyInMemory = key;
  try {
    if (key === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Storage can be unavailable; the in-memory copy still works for this page.
  }
}

/**
 * A key for something about to be created. The server treats a repeat of the
 * same command under the same key as the same request, so a retry after a
 * lost response cannot post twice. crypto.randomUUID exists only on secure
 * origins; getRandomValues works on plain HTTP too.
 */
export function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's name for the refusal, when it gave one. */
    readonly code: string = "error",
  ) {
    super(message);
  }

  /** True when the request may have taken effect although no answer arrived. */
  get outcomeUnknown(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/**
 * Why a request was refused, in the catalog's words where the server named
 * the refusal, and otherwise as the server put it.
 */
function describe(body: unknown, status: number): { message: string; code: string } {
  if (body && typeof body === "object" && "detail" in body) {
    const { detail, code } = body as { detail: unknown; code?: unknown };
    if (typeof detail === "string") {
      const named = typeof code === "string" ? code : "error";
      return { message: tMaybe(`refusal.${named}`, detail), code: named };
    }
    if (Array.isArray(detail)) {
      const lines = detail.map((item: unknown) => {
        if (item && typeof item === "object" && "msg" in item) {
          const { msg, loc } = item as { msg: unknown; loc?: unknown };
          const path = Array.isArray(loc) ? loc.filter((part) => part !== "body" && part !== "command").join(".") : "";
          return path ? `${path}: ${String(msg)}` : String(msg);
        }
        return String(item);
      });
      if (lines.length) return { message: t("refusal.invalid", { detail: lines.join("; ") }), code: "invalid" };
    }
  }
  return { message: t("error.status", { status }), code: "error" };
}

const sendKey: Middleware = {
  onRequest({ request }) {
    const key = readKey();
    if (key) request.headers.set("X-API-Key", key);
    return request;
  },
};

export const api = createClient<paths>({
  baseUrl: window.location.origin,
  // No request waits forever: a hung connection becomes an error the person sees.
  fetch: (request) => globalThis.fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
});
api.use(sendKey);

/** The response body, or an ApiError that says why there is none. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await call;
  } catch {
    throw new ApiError(0, t("error.network"));
  }
  const { data, error, response } = result;
  if (!response.ok || data === undefined) {
    if (response.status === 401) {
      writeKey(null);
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    const { message, code } = describe(error, response.status);
    throw new ApiError(response.status, message, code);
  }
  return data;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reached(position: number): Promise<boolean> {
  try {
    return (await unwrap(api.GET("/api/v1/position"))).position >= position;
  } catch {
    return false; // One failed poll decides nothing.
  }
}

/**
 * Read models trail commands by a moment (WAX-0001). A command answers with a
 * position; this waits until the read models have passed it, so the screen
 * that refreshes afterward shows the change. False means it did not happen
 * in time, and the caller says so instead of showing stale data as current.
 */
export async function settle(position: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Promise.race([reached(position), pause(deadline - Date.now()).then(() => false)])) return true;
    await pause(150);
  }
  return false;
}

/**
 * After settle gave up: keep watching, slowly, and call back when the read
 * models do pass the position, so a screen that said it would refresh does.
 */
export function followUp(position: number, onReached: () => void): void {
  const started = Date.now();
  const check = async () => {
    if (await reached(position)) onReached();
    else if (Date.now() - started < 30 * 60_000) setTimeout(check, 3000);
  };
  setTimeout(check, 3000);
}

/** Poll for something a command may have created although its answer was lost. */
export async function existsSoon(look: () => Promise<unknown>, forMs = 6000): Promise<boolean> {
  const deadline = Date.now() + forMs;
  for (;;) {
    try {
      await look();
      return true;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && !error.outcomeUnknown)) return false;
    }
    if (Date.now() >= deadline) return false;
    await pause(500);
  }
}
