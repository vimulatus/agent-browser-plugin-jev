import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSnapshot } from "../dist/snapshot.js";

function fixtureText(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).data.snapshot;
}

const login = parseSnapshot(fixtureText("snapshot-login.json"));
const widgets = parseSnapshot(fixtureText("snapshot-widgets.json"));

function byRef(elements, ref) {
  const element = elements.find((e) => e.ref === ref);
  assert.ok(element, `no element with ref ${ref}`);
  return element;
}

test("a textbox carries its value and gets TYPE_TEXT and CLICK", () => {
  const email = byRef(login, "e5");
  assert.equal(email.role, "textbox");
  assert.equal(email.label, "Email");
  assert.equal(email.value, "a@b.c");
  assert.deepEqual(email.operations, ["TYPE_TEXT", "CLICK"]);
});

test("a checkbox and a radio carry checked and get CLICK", () => {
  const remember = byRef(login, "e3");
  assert.equal(remember.label, "Remember");
  assert.equal(remember.checked, true);
  assert.deepEqual(remember.operations, ["CLICK"]);
  assert.equal(byRef(login, "e10").checked, true);
  assert.equal(byRef(login, "e11").checked, false);
});

test("a select is a combobox with options, the selected one marked, and gets SELECT", () => {
  const plan = byRef(login, "e7");
  assert.equal(plan.value, "Pro");
  assert.equal(plan.expanded, false);
  assert.deepEqual(plan.operations, ["SELECT"]);
  assert.deepEqual(plan.options, [
    { index: `${plan.index}:1`, ref: "e12", label: "Free", value: "Free", selected: false },
    { index: `${plan.index}:2`, ref: "e13", label: "Pro", value: "Pro", selected: true },
  ]);
  assert.equal(login.find((e) => e.ref === "e12"), undefined);
});

test("an editable combobox without options gets TYPE_TEXT and CLICK", () => {
  const city = byRef(widgets, "e16");
  assert.equal(city.value, "Par");
  assert.equal(city.options, undefined);
  assert.deepEqual(city.operations, ["TYPE_TEXT", "CLICK"]);
  assert.deepEqual(byRef(widgets, "e17").operations, ["SELECT"]);
});

test("links, buttons, tabs and menu items get CLICK; tabs carry selected", () => {
  assert.deepEqual(byRef(login, "e2").operations, ["CLICK"]);
  assert.deepEqual(byRef(login, "e4").operations, ["CLICK"]);
  assert.deepEqual(byRef(widgets, "e20").operations, ["CLICK"]);
  assert.equal(byRef(widgets, "e18").selected, true);
  assert.equal(byRef(widgets, "e19").selected, false);
  assert.equal(byRef(widgets, "e14").expanded, false);
});

test("searchbox and spinbutton get TYPE_TEXT and CLICK", () => {
  assert.deepEqual(byRef(login, "e8").operations, ["TYPE_TEXT", "CLICK"]);
  assert.equal(byRef(login, "e9").value, "3");
  assert.deepEqual(byRef(login, "e9").operations, ["TYPE_TEXT", "CLICK"]);
});

test("a password field is typeable and marked, so a run masks what it logs", () => {
  const password = byRef(login, "e6");
  assert.equal(password.password, true);
  assert.deepEqual(password.operations, ["TYPE_TEXT", "CLICK"]);
  const typed = parseSnapshot(fixtureText("snapshot-login-typed.json"));
  assert.equal(byRef(typed, "e6").password, true);
  assert.equal(byRef(login, "e5").password, undefined);
});

test("headings and disabled elements are left out", () => {
  assert.equal(login.find((e) => e.ref === "e1"), undefined);
  assert.equal(widgets.find((e) => e.ref === "e15"), undefined);
});

test("indexes count from 1 in page order", () => {
  assert.deepEqual(
    login.map((e) => e.index),
    login.map((_, i) => String(i + 1)),
  );
  assert.equal(login[0].ref, "e5");
});

test("names with escaped quotes and elements without a name parse", () => {
  const elements = parseSnapshot(
    '- button "Say \\"hi\\"" [ref=e1]\n- combobox [expanded=false, ref=e2]: Y\n  - option "Y" [selected, ref=e3]',
  );
  assert.equal(elements[0].label, 'Say "hi"');
  assert.equal(elements[1].label, "");
  assert.equal(elements[1].value, "Y");
  assert.equal(elements[1].options[0].selected, true);
});

test("the element list is capped at 250", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `- button "b${i}" [ref=e${i}]`);
  assert.equal(parseSnapshot(lines.join("\n")).length, 250);
});
