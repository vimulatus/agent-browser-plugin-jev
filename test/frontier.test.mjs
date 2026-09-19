import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseNext } from "../dist/choose.js";
import { DEFAULT_FIXTURES, loadFixtures } from "../dist/fixtures.js";
import { frontier } from "../dist/frontier.js";
import { parseSnapshot } from "../dist/snapshot.js";

const SHOP = "http://127.0.0.1:8765/shop.html";
const shop = parseSnapshot('- link "Orders" [ref=e1]\n- button "Save" [ref=e2]');

test("the frontier keys a control by its page, its role and its label", () => {
  const seen = frontier();
  seen.see(SHOP, shop);
  seen.see(`${SHOP}?page=2`, shop);
  seen.see("http://127.0.0.1:8765/orders.html", shop);

  assert.deepEqual(
    seen.entries().map((entry) => `${entry.path}|${entry.role}|${entry.label}`),
    ["/shop.html|link|Orders", "/shop.html|button|Save", "/orders.html|link|Orders", "/orders.html|button|Save"],
  );
});

test("a control that has been tried is not offered again, on this page or anywhere", () => {
  const seen = frontier();
  seen.see(SHOP, shop);
  const [orders] = seen.here(SHOP, shop);
  orders.entry.tried = true;

  assert.deepEqual(
    seen.here(SHOP, shop).map(({ element }) => element.label),
    ["Save"],
  );
  assert.equal(seen.pending().label, "Save");
  seen.here(SHOP, shop)[0].entry.tried = true;
  assert.equal(seen.pending(), null);
});

test("the built-in fixtures cover the five kinds of value a form asks for", () => {
  assert.deepEqual(Object.keys(loadFixtures()), ["email", "password", "name", "phone", "address"]);
  assert.equal(loadFixtures().email, DEFAULT_FIXTURES.email);
});

test("--fixtures overrides a built-in key and adds its own", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-fixtures-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixtures.yaml");
  writeFileSync(path, 'email: qa@acme.test\ncompany: Acme Ltd\n');

  const fixtures = loadFixtures(path);
  assert.equal(fixtures.email, "qa@acme.test");
  assert.equal(fixtures.company, "Acme Ltd");
  assert.equal(fixtures.password, DEFAULT_FIXTURES.password);

  writeFileSync(path, "email: [one, two]\n");
  assert.throws(() => loadFixtures(path), /email must be the text to type/);
});

test("a fixture key the Choice is not sure of leaves the field empty", async () => {
  const snapshot = '- textbox "Nickname" [ref=e1]\n- textbox "Email" [ref=e2]';
  const elements = parseSnapshot(snapshot);
  const url = "http://127.0.0.1:8765/profile.html";
  const seen = frontier();
  seen.see(url, elements);
  const jev = {
    async ask() {
      return {
        model: "jev-1.13.0",
        answers: {
          next_element: {
            type: "choice",
            choice: "1",
            confidence: 0.58,
            probabilities: { 1: 0.58, 2: 0.42 },
          },
          fixture_value_1: {
            type: "choice",
            choice: "name",
            confidence: 0.42,
            probabilities: { email: 0.2, password: 0.05, name: 0.42, phone: 0.05, address: 0.03, NONE: 0.25 },
          },
        },
      };
    },
  };

  const chosen = await chooseNext({
    jev,
    model: "jev-latest",
    observation: {
      url,
      title: "Profile",
      text: snapshot,
      elements,
      console: [],
      errors: [],
      requests: [],
      hash: "0".repeat(64),
    },
    untried: seen.here(url, elements),
    fixtures: loadFixtures(),
    allow: "all",
    recent: [],
  });

  assert.equal(chosen.element.label, "Nickname");
  assert.equal(chosen.fixture, null, "0.42 is not enough to type a value into someone's form");
  assert.equal(chosen.value, null);
});
