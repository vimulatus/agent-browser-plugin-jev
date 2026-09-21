/** Starts a monotonic stopwatch: the function it returns is the whole milliseconds since this call. */
export function stopwatch(): () => number {
  const started = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - started) / 1_000_000n);
}
