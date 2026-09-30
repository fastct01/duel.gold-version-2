/* One error type for everything the API can refuse. `code` is stable and machine-readable; `status` is the HTTP status. */
export class AppError extends Error {
  constructor(code, message, status = 400, extra) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (extra) this.extra = extra;
  }
}

export const bad = (code, message, extra) => new AppError(code, message, 400, extra);
export const forbidden = (code, message, extra) => new AppError(code, message, 403, extra);
export const notFound = (message = "Not found.") => new AppError("NOT_FOUND", message, 404);
export const conflict = (code, message, extra) => new AppError(code, message, 409, extra);

/* A message that is safe to show or log. ethers appends request details to error text, including the RPC URL, and
   provider URLs usually carry the API key in the path — so URLs are always replaced. */
export function safeMessage(e) {
  const m = String((e && (e.shortMessage || e.message)) || e);
  return m.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]]+/gi, "[url]").slice(0, 300);
}
