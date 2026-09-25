import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKey, headers } from "../dist/jev.js";

/** A fetch that answers every call with one status and counts the calls, so no test reaches the API. */
function answering(status) {
  const calls = [];
  const post = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  };
  return { calls, post };
}

const PROXY = { HTTPS_PROXY: "http://127.0.0.1:9" };

test("a set key passes without a call", async () => {
  const { calls, post } = answering(401);
  await checkKey({ TYPESAFE_API_KEY: "k", ...PROXY }, post);
  assert.equal(calls.length, 0);
});

test("no key and no proxy fails without a call", async () => {
  const { calls, post } = answering(422);
  await assert.rejects(checkKey({ TYPESAFE_API_KEY: "" }, post), /^Error: TYPESAFE_API_KEY is not set$/);
  assert.equal(calls.length, 0);
});

test("no key behind a proxy passes when the API gets past authentication", async () => {
  for (const env of [PROXY, { https_proxy: PROXY.HTTPS_PROXY }]) {
    const { calls, post } = answering(422);
    await checkKey(env, post);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body, "{}");
    assert.equal(calls[0].init.headers.authorization, undefined);
  }
});

test("no key behind a proxy fails when the API refuses the call", async () => {
  for (const status of [401, 403]) {
    const { post } = answering(status);
    await assert.rejects(checkKey(PROXY, post), new RegExp(`TYPESAFE_API_KEY is not set.*HTTP ${status}`));
  }
});

test("no key behind a proxy fails when the API cannot be reached", async () => {
  const post = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(checkKey(PROXY, post), /connection failed, nothing acted/);
});

test("a call carries the key when there is one, and no Authorization when there is none", () => {
  assert.equal(headers("k").authorization, "Bearer k");
  assert.equal(headers(undefined).authorization, undefined);
  assert.equal(headers("").authorization, undefined);
});
