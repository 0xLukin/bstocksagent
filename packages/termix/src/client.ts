import type { SessionTokens } from "./types.js";

export type TermixClientOptions = {
  apiBase?: string;
  accessToken?: string;
  runtimeToken?: string;
};

export class TermixHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Termix ${status} ${path}: ${body}`);
    this.name = "TermixHttpError";
  }
}

export class TermixClient {
  readonly apiBase: string;
  accessToken?: string;
  runtimeToken?: string;

  constructor(opts: TermixClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env.AACP_API ?? "https://platform-backend.prod.termix.live").replace(
      /\/$/,
      "",
    );
    this.accessToken = opts.accessToken;
    this.runtimeToken = opts.runtimeToken;
  }

  applySession(session: SessionTokens) {
    this.accessToken = session.accessToken;
  }

  async request<T>(
    path: string,
    init: RequestInit & { auth?: "session" | "runtime" | "none" } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }
    const mode = init.auth ?? "session";
    if (mode === "session" && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    if (mode === "runtime" && this.runtimeToken) {
      headers.set("authorization", `Bearer ${this.runtimeToken}`);
    }
    const res = await fetch(`${this.apiBase}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new TermixHttpError(res.status, text.slice(0, 2000), path);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
