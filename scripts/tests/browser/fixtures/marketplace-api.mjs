import {
  createMarketplaceFixtures,
  forwardMarketplacePayload,
  legacyMarketplacePayload
} from "../../contracts/marketplace.mjs";

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body)
  });
}

function readBody(request) {
  const text = request.postData();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

export function createMarketplaceApi() {
  const fixtures = createMarketplaceFixtures();
  const state = {
    profile: "web",
    failNext: new Set(),
    abortNext: new Set(),
    hangNext: new Set(),
    variants: new Map(),
    requests: [],
    installRequests: [],
    browserErrors: []
  };

  function response(kind, payload) {
    const variant = state.variants.get(kind);
    if (variant === "legacy") return legacyMarketplacePayload(kind, payload);
    if (variant === "forward") return {
      ...forwardMarketplacePayload(kind, payload),
      schemaVersion: 1
    };
    return payload;
  }

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    state.requests.push({ method, path, query: Object.fromEntries(url.searchParams) });

    if (method === "GET" && path === "/api/marketplace/profile") {
      return json(route, 200, response("profile", { status: "done", profile: state.profile }));
    }
    if (method === "POST" && path === "/api/marketplace/profile") {
      if (state.failNext.delete("profile")) return json(route, 500, { error: "fixture profile unavailable" });
      const body = readBody(request);
      state.profile = body.profile;
      return json(route, 200, response("profile", { status: "done", profile: state.profile }));
    }
    if (method === "GET" && path === "/api/marketplace/list") {
      if (state.failNext.delete("list")) return json(route, 503, { error: "fixture list unavailable" });
      if (state.abortNext.delete("list")) return route.abort("failed");
      if (url.searchParams.get("refresh") === "1" && state.hangNext.delete("list")) return new Promise(() => {});
      return json(route, 200, response("list", fixtures.list));
    }
    if (method === "GET" && path === "/api/marketplace/skills") {
      if (state.failNext.delete("skills")) return json(route, 503, { error: "fixture skills unavailable" });
      return json(route, 200, response("skills", {
        ...fixtures.skills,
        page: Number(url.searchParams.get("page") || "1"),
        pageSize: Number(url.searchParams.get("pageSize") || "20")
      }));
    }
    if (method === "POST" && path === "/api/marketplace/install") {
      const body = readBody(request);
      const answers = body.answers && typeof body.answers === "object" ? { ...body.answers } : {};
      state.installRequests.push({ repo: body.repo, answers });
      if (body.repo !== "fixture-owner/fixture-ready") return json(route, 404, { error: "fixture repository unavailable" });
      if (answers.__confirm_npm_scripts__ === "deny") {
        return json(route, 200, response("install", fixtures.installAborted));
      }
      if (answers.__confirm_npm_scripts__ !== "allow") {
        return json(route, 200, response("install", fixtures.installAwaiting));
      }
      return json(route, 200, response("install", fixtures.installDone));
    }
    if (method === "POST" && path === "/api/marketplace/uninstall") {
      return json(route, 200, response("uninstall", fixtures.uninstall));
    }
    if (method === "GET" && path === "/api/marketplace/feedback/token") {
      return json(route, 200, response("feedbackToken", fixtures.feedbackToken));
    }
    if (method === "GET" && path === "/api/marketplace/feedback/pending") {
      return json(route, 200, response("feedbackPending", fixtures.feedbackPending));
    }
    if (method === "GET" && path === "/api/marketplace/self-update") {
      return json(route, 200, response("selfUpdate", fixtures.selfUpdate));
    }
    if (method === "GET" && path === "/api/marketplace/env-keys") {
      return json(route, 200, response("envKeys", fixtures.envKeys));
    }
    return json(route, 404, { error: "fixture endpoint unavailable" });
  }

  return {
    handle,
    failNext(name) {
      state.failNext.add(name);
    },
    abortNext(name) {
      state.abortNext.add(name);
    },
    hangNext(name) {
      state.hangNext.add(name);
    },
    setVariant(kind, variant) {
      if (variant === null) state.variants.delete(kind);
      else state.variants.set(kind, variant);
    },
    requests: state.requests,
    installRequests: state.installRequests,
    get browserErrors() {
      return state.browserErrors;
    },
    set browserErrors(value) {
      state.browserErrors = value;
    }
  };
}
