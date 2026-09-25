/** What a run writes in place of a secret: a value typed into a field that takes one, or a value given to `resume`. */
export const MASK = "•••";

/**
 * A value this short is masked only where it sits in its own field, never as text elsewhere: a code box's one
 * digit would otherwise mask every digit in the run's files.
 */
const MIN_TEXT_LENGTH = 4;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The secrets one run has typed, and the masking every file and line it writes goes through. A secret is masked as
 * text wherever it appears, and the field it was typed into shows the mask as its value, in an element and in a tree.
 */
export class Secrets {
  private readonly values = new Set<string>();
  private readonly labels = new Set<string>();

  add(value: string, label: string | null = null): void {
    if (value !== "") this.values.add(value);
    if (label !== null) this.labels.add(label);
  }

  get empty(): boolean {
    return this.values.size === 0 && this.labels.size === 0;
  }

  /** The text with every secret replaced, and each secret field's value in a tree line (`- textbox "Code" [ref=e2]: 123456`). */
  text(text: string): string {
    let masked = text;
    const long = [...this.values].filter((value) => value.length >= MIN_TEXT_LENGTH).sort((a, b) => b.length - a.length);
    for (const value of long) masked = masked.split(value).join(MASK);
    for (const label of this.labels) {
      const line = new RegExp(`^(\\s*- [a-z]+ "${escaped(label.replace(/"/g, '\\"'))}"(?: \\[[^\\]]*\\])?): .*$`, "gm");
      masked = masked.replace(line, `$1: ${MASK}`);
    }
    return masked;
  }

  /**
   * A copy of `value` fit to write: every string and key masked as text, and the `value` of any object whose `label`
   * names a secret field, such as an element, masked whole.
   */
  scrub<T>(value: T): T {
    if (this.empty) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") return this.text(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node === null || typeof node !== "object") return node;
      const record = node as Record<string, unknown>;
      const field = typeof record.label === "string" && this.labels.has(record.label);
      return Object.fromEntries(
        Object.entries(record).map(([key, inner]) => [
          this.text(key),
          field && key === "value" && typeof inner === "string" && inner !== "" ? MASK : walk(inner),
        ]),
      );
    };
    return walk(value) as T;
  }
}
