export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8787/api";

export class AdminApiError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code = "REQUEST_FAILED", details: unknown = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof payload.error === "object" ? payload.error : { message: payload.error, code: payload.code, details: payload.details };
    throw new AdminApiError(error?.message || "请求失败", error?.code || "REQUEST_FAILED", error?.details);
  }
  return payload?.ok === true && Object.hasOwn(payload, "data") ? payload.data : payload;
}

export const jsonRequest = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});
