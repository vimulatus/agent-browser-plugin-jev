export const PROTOCOL = "agent-browser.plugin.v1";

/** What `agent-browser plugin add` records for this plugin. */
export const MANIFEST = {
  name: "jev",
  capabilities: ["command.run", "jev.run", "jev.status"],
  description: "Jev drives the browser from one goal or one policy",
};

/** The one JSON object agent-browser writes to the plugin's stdin. */
export interface Envelope {
  protocol: string;
  type: string;
  capability?: string;
  request?: unknown;
}

export type Response =
  | { protocol: typeof PROTOCOL; success: true; manifest: typeof MANIFEST }
  | { protocol: typeof PROTOCOL; success: false; error: string };

function failure(error: string): Response {
  return { protocol: PROTOCOL, success: false, error };
}

function parseEnvelope(stdin: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    return null;
  }
  const envelope = value as Envelope | null;
  return typeof envelope?.type === "string" && typeof envelope.protocol === "string" ? envelope : null;
}

/** Answers the envelope on stdin. Only `plugin.manifest` is served. */
export function answer(stdin: string): Response {
  const envelope = parseEnvelope(stdin);
  if (envelope === null) return failure("stdin is not a plugin envelope");
  if (envelope.protocol !== PROTOCOL) return failure(`unsupported protocol: ${envelope.protocol}`);
  if (envelope.type === "plugin.manifest") return { protocol: PROTOCOL, success: true, manifest: MANIFEST };
  return failure(`unsupported request type: ${envelope.type}`);
}
