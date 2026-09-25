import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

let agent: EnvHttpProxyAgent | undefined;

/**
 * `fetch` through `HTTPS_PROXY` when one is set, minding `NO_PROXY`. Node's own fetch ignores both,
 * so behind a proxy a call went direct, which a network that only lets the proxy out refuses.
 */
export function fetch(url: string, init: RequestInit): Promise<Response> {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return globalThis.fetch(url, init);
  agent ??= new EnvHttpProxyAgent();
  return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
