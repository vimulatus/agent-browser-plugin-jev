import { createHash } from "node:crypto";

/** Fingerprint of a page state: the url and the full snapshot text, so typing or navigating changes it. */
export function pageHash(url: string, snapshot: string): string {
  return createHash("sha256").update(url).update("\n").update(snapshot).digest("hex");
}
