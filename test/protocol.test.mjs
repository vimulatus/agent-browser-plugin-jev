import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const PROTOCOL = "agent-browser.plugin.v1";

function invoke(envelope) {
  const result = spawnSync("node", ["dist/main.js"], {
    encoding: "utf8",
    input: JSON.stringify(envelope),
  });
  return { ...result, body: JSON.parse(result.stdout) };
}

test("plugin.manifest names the plugin and its capabilities", () => {
  const { status, body } = invoke({
    protocol: PROTOCOL,
    type: "plugin.manifest",
    capability: "plugin.manifest",
    request: {},
  });
  assert.equal(status, 0);
  assert.equal(body.protocol, PROTOCOL);
  assert.equal(body.success, true);
  assert.equal(body.manifest.name, "jev");
  assert.deepEqual(body.manifest.capabilities, ["command.run", "jev.run", "jev.status"]);
  assert.equal(typeof body.manifest.description, "string");
});

test("any other request type is rejected with success false", () => {
  const { status, body } = invoke({
    protocol: PROTOCOL,
    type: "jev.explain",
    capability: "command.run",
    request: {},
  });
  assert.equal(status, 0);
  assert.equal(body.protocol, PROTOCOL);
  assert.equal(body.success, false);
  assert.match(body.error, /jev\.explain/);
});

test("an unknown protocol is rejected with success false", () => {
  const { body } = invoke({ protocol: "agent-browser.plugin.v2", type: "plugin.manifest" });
  assert.equal(body.protocol, PROTOCOL);
  assert.equal(body.success, false);
  assert.match(body.error, /protocol/);
});

test("stdin that is not JSON is rejected with success false", () => {
  const result = spawnSync("node", ["dist/main.js"], { encoding: "utf8", input: "not json" });
  const body = JSON.parse(result.stdout);
  assert.equal(body.success, false);
});
