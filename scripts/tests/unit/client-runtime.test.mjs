import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const events = [];
const loads = [];
const styles = new Map();
const reactCalls = [];
const effectCleanups = [];
const reactEffectCleanups = [];
const localeSubscribers = [];
const slotRegistrations = [];
let appendedStyles = 0;

const document = {
  head: {
    appendChild(element) {
      appendedStyles++;
      styles.set(element.id, element);
      events.push("styles.append");
    }
  },
  body: { appendChild() {}, removeChild() {} },
  getElementById(id) {
    if (id === "dshm-styles") events.push("styles.lookup");
    return styles.get(id) || null;
  },
  createElement(tag) {
    assert.equal(tag, "style");
    return { id: "", textContent: "" };
  }
};

const fakeReact = {
  createElement(type, props, ...children) {
    reactCalls.push([type, props, ...children]);
    if (typeof type === "function") return type(props || {});
    return { type, props, children };
  },
  useState(initial) {
    const value = typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  },
  useEffect(effect) {
    const cleanup = effect();
    if (typeof cleanup === "function") reactEffectCleanups.push(cleanup);
  }
};

const locale = {
  register(namespace, dictionaries) {
    events.push("locale.register");
    assert.equal(namespace, "dsh-plugin-marketplace");
    assert.ok(dictionaries.zh && dictionaries.en);
    return () => events.push("locale.dispose");
  },
  bind(namespace) {
    events.push("locale.bind");
    assert.equal(namespace, "dsh-plugin-marketplace");
    return (key) => `bound:${key}`;
  },
  getLocale() {
    events.push("locale.getLocale");
    return { active: "en" };
  },
  subscribe(callback) {
    events.push("locale.subscribe");
    localeSubscribers.push(callback);
  }
};

const ctx = {
  locale,
  effect(cleanupFactory, label) {
    events.push("effect");
    assert.equal(label, "dsh-plugin-marketplace: dictionaries");
    effectCleanups.push(cleanupFactory);
  },
  slots: {
    inject(slotName, callback) {
      events.push("slots.inject");
      assert.equal(slotName, "settings.section");
      const registration = callback();
      assert.ok(registration);
      registration.component({});
    },
    register(metadata, component) {
      events.push("slots.register");
      slotRegistrations.push({ metadata, component });
      return { metadata, component };
    }
  }
};

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        loads.push(definition);
      }
    },
    __DSH_MP_TOKEN__: "test-token"
  },
  document,
  navigator: { language: "en-US" },
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob,
  FileReader: function FileReader() {},
  AbortSignal: { timeout() {} },
  IntersectionObserver: function IntersectionObserver() {},
  fetch() { return Promise.reject(new Error("not called")); }
};

vm.runInNewContext(source, sandbox, { filename: "dsh-plugin-marketplace-client.bundle.js" });
assert.equal(loads.length, 1, "bundle registers exactly one loader module");
assert.equal(loads[0].id, "dsh-plugin-marketplace");
assert.equal(typeof loads[0].factory, "function");
assert.equal(loads[0].factory.length, 1);

let requireCalls = 0;
const moduleExports = loads[0].factory((name) => {
  requireCalls++;
  assert.equal(name, "react");
  return fakeReact;
});
assert.equal(requireCalls, 1);
assert.equal(typeof moduleExports.apply, "function");
assert.deepEqual(Array.from(moduleExports.inject), ["slots", "locale"]);

moduleExports.apply(ctx);
assert.deepEqual(events, [
  "styles.lookup",
  "styles.append",
  "locale.register",
  "effect",
  "locale.bind",
  "locale.getLocale",
  "locale.subscribe",
  "slots.inject",
  "slots.register"
]);
assert.equal(appendedStyles, 1);
assert.equal(slotRegistrations.length, 1);
assert.equal(slotRegistrations[0].metadata.id, "dsh-plugin-marketplace");
assert.equal(slotRegistrations[0].metadata.locale, "dsh-plugin-marketplace");
assert.equal(typeof slotRegistrations[0].metadata.label, "function");
assert.equal(slotRegistrations[0].metadata.label(), "bound:sectionLabel");
assert.equal(typeof slotRegistrations[0].component, "function");
assert.ok(reactCalls.length > 0, "slot consumption renders the marketplace component");

const style = styles.get("dshm-styles");
assert.ok(style.textContent.length > 0);
const originalCss = style.textContent;
style.textContent = "stale-css";
moduleExports.apply(ctx);
assert.equal(appendedStyles, 1, "reapplying does not append a second style element");
assert.equal(style.textContent, originalCss, "reapplying overwrites stale CSS");
assert.equal(localeSubscribers.length, 2);
assert.equal(effectCleanups.length, 2);
const cleanup = effectCleanups[0]();
assert.equal(typeof cleanup, "function");
cleanup();
assert.ok(events.includes("locale.dispose"));

console.log("client runtime contract: 23 passed, 0 failed");
