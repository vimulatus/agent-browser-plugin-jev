/** One step as the progress line reads it: a goal run's step, or a walk's. */
export interface Progress {
  step: number;
  operation: string;
  label: string | null;
  /** Already masked when the field takes a secret: the line goes through the same mask as the run's files. */
  value: string | null;
  confidence: number | null;
}

const SHORT: Record<string, string> = { TYPE_TEXT: "TYPE" };

/** `step 4 · TYPE "Verification Code" ← ••• · 0.90`: what one step did, for a person watching the run. */
export function stepLine({ step, operation, label, value, confidence }: Progress): string {
  const act = [SHORT[operation] ?? operation, ...(label === null ? [] : [JSON.stringify(label)])].join(" ");
  const typed = value === null ? "" : ` ← ${value}`;
  const sure = confidence === null ? "" : ` · ${confidence.toFixed(2)}`;
  return `step ${step} · ${act}${typed}${sure}`;
}
