import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, parseBuckets, bucketOf } from "../dist/policy/range.js";

test("comparison ranges", () => {
  assert.equal(parseRange("<400")(399), true);
  assert.equal(parseRange("<400")(400), false);
  assert.equal(parseRange("<=400")(400), true);
  assert.equal(parseRange(">500")(500), false);
  assert.equal(parseRange(">500")(501), true);
  assert.equal(parseRange(">=500")(500), true);
  assert.equal(parseRange(">= 500")(500), true);
});

test("a-b is inclusive at both ends and accepts decimals", () => {
  const range = parseRange("400-499");
  assert.equal(range(400), true);
  assert.equal(range(499), true);
  assert.equal(range(500), false);
  assert.equal(range(399), false);
  assert.equal(parseRange("0.5-1.5")(1.5), true);
});

test("anything else is rejected with the text in the message", () => {
  for (const bad of ["400", "", "<>400", "400-", "abc", "> x"]) {
    assert.throws(() => parseRange(bad), /range/);
  }
});

test("bucketOf returns the first matching bucket, in policy order, or undefined", () => {
  const buckets = parseBuckets({ ok: "<400", client_error: "400-499", server_error: ">=500" });
  assert.equal(bucketOf(buckets, 200), "ok");
  assert.equal(bucketOf(buckets, 404), "client_error");
  assert.equal(bucketOf(buckets, 500), "server_error");
  assert.equal(bucketOf(buckets, null), undefined);
  assert.equal(bucketOf(parseBuckets({ low: "<10" }), 10), undefined);
  assert.equal(bucketOf(parseBuckets({ a: "<10", b: "<20" }), 5), "a");
});
