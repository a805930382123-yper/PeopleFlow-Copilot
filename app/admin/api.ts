export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

export class AdminApiError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code = "REQUEST_FAILED", details: unknown = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
  timeoutMessage?: string;
};

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = 30000, timeoutMessage = "请求超时，请稍后重试。", ...requestInit } = init;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...requestInit,
      signal: requestInit.signal || controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = typeof payload.error === "object" ? payload.error : { message: payload.error, code: payload.code, details: payload.details };
      throw new AdminApiError(error?.message || "请求失败", error?.code || "REQUEST_FAILED", error?.details);
    }
    return payload?.ok === true && Object.hasOwn(payload, "data") ? payload.data : payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AdminApiError(timeoutMessage, "REQUEST_TIMEOUT");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const adminRequest = apiRequest;

export const jsonRequest = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});
