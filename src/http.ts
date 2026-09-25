import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/** The proxy HTTPS goes through, or undefined. Behind one, the proxy may add `TYPESAFE_API_KEY` itself. */
export function httpsProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HTTPS_PROXY || env.https_proxy || undefined;
}

let agent: EnvHttpProxyAgent | undefined;

/**
 * `fetch` through `HTTPS_PROXY` when one is set, minding `NO_PROXY`. Node's own fetch ignores both,
 * so behind a proxy a call went direct and never reached what the proxy adds.
 */
export function fetch(url: string, init: RequestInit): Promise<Response> {
  if (httpsProxy() === undefined) return globalThis.fetch(url, init);
  agent ??= new EnvHttpProxyAgent();
  return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
