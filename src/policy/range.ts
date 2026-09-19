/** A predicate over one measured number. */
export type Range = (value: number) => boolean;

/** Bucket names with their ranges, in policy order. */
export type Buckets = { name: string; range: Range }[];

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const COMPARISON = new RegExp(String.raw`^(<=|>=|<|>)\s*(${NUMBER})$`);
const SPAN = new RegExp(String.raw`^(${NUMBER})\s*-\s*(${NUMBER})$`);

/** Parses `<n`, `<=n`, `>n`, `>=n` or the inclusive `a-b`. */
export function parseRange(text: string): Range {
  const comparison = COMPARISON.exec(text.trim());
  if (comparison) {
    const limit = Number(comparison[2]);
    switch (comparison[1]) {
      case "<":
        return (value) => value < limit;
      case "<=":
        return (value) => value <= limit;
      case ">":
        return (value) => value > limit;
      default:
        return (value) => value >= limit;
    }
  }
  const span = SPAN.exec(text.trim());
  if (span) {
    const [low, high] = [Number(span[1]), Number(span[2])];
    return (value) => value >= low && value <= high;
  }
  throw new Error(`range "${text}" is not one of <n, <=n, >n, >=n or a-b`);
}

export function parseBuckets(spec: Record<string, string>): Buckets {
  return Object.entries(spec).map(([name, text]) => ({ name, range: parseRange(text) }));
}

/** The first bucket whose range holds the value; undefined when none does or there is no value. */
export function bucketOf(buckets: Buckets, value: number | null | undefined): string | undefined {
  if (typeof value !== "number") return undefined;
  return buckets.find((b) => b.range(value))?.name;
}
