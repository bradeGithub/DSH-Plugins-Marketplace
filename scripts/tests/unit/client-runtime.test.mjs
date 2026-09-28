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
      element.parentNode = this;
      styles.set(element.id, element);
      events.push("styles.append");
    },
    removeChild(element) {
      styles.delete(element.id);
      element.parentNode = null;
      events.push("styles.remove");
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
    return () => {
      const idx = localeSubscribers.indexOf(callback);
      if (idx >= 0) localeSubscribers.splice(idx, 1);
      events.push("locale.unsubscribe");
    };
  }
};

const effectLabels = [];
const ctx = {
  locale,
  effect(cleanupFactory, label) {
    events.push("effect");
    effectLabels.push(label);
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
  "effect",
  "locale.register",
  "effect",
  "locale.bind",
  "locale.getLocale",
  "locale.subscribe",
  "effect",
  "slots.inject",
  "slots.register"
]);
// 生命周期契约：三个注册面各收集一次（slots.inject 自带 fiber 作用域，不重复收集）
assert.deepEqual(effectLabels, [
  "dsh-plugin-marketplace: styles",
  "dsh-plugin-marketplace: dictionaries",
  "dsh-plugin-marketplace: locale subscription"
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
assert.equal(effectCleanups.length, 6);

// BDD 卸载面：逆序执行 apply-2 收集的 3 个 disposer（cordis 卸载即此序）——
// 样式标签摘除、字典释放、locale 订阅退订，无残留。
for (let i = 5; i >= 3; i--) {
  const cleanup = effectCleanups[i]();
  assert.equal(typeof cleanup, "function");
  cleanup();
}
assert.equal(styles.has("dshm-styles"), false, "卸载后样式标签摘除");
assert.equal(localeSubscribers.length, 1, "卸载后 apply-2 的 locale 订阅退订");
assert.ok(events.includes("locale.dispose"));
assert.ok(events.includes("locale.unsubscribe"));
assert.ok(events.includes("styles.remove"));

// apply-1 的 3 个 disposer 同样卸载 → 订阅清零（无泄漏累积）
for (let i = 2; i >= 0; i--) {
  const cleanup = effectCleanups[i]();
  if (typeof cleanup === "function") cleanup();
}
assert.equal(localeSubscribers.length, 0, "全部卸载后无订阅残留");

console.log("client runtime contract: 30 passed, 0 failed");
