/**
 * Server-side Runtime base URL.
 * Production / `next build`: only NEXT_PUBLIC_RUNTIME_URL (Vercel env).
 * `next dev`: may follow RUNTIME_PUBLIC_URL when local Runtime is not on 8787.
 */
export function runtimeOrigin(): string {
  const raw =
    process.env.NODE_ENV === "development"
      ? (process.env.RUNTIME_PUBLIC_URL ?? process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787")
      : (process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787");
  return raw.replace(/\/$/, "");
}
