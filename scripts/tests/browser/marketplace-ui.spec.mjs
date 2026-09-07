import { expect, test as base } from "@playwright/test";
import { createDshHost, openMarketplace } from "./fixtures/dsh-host.mjs";
import { createMarketplaceApi } from "./fixtures/marketplace-api.mjs";

const test = base.extend({
  host: async ({}, use) => {
    const host = await createDshHost();
    try {
      await use(host);
    } finally {
      await host.close();
    }
  },
  marketplaceApi: async ({ page }, use) => {
    const api = createMarketplaceApi();
    await page.route("**/api/marketplace/**", (route) => api.handle(route));
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });
    api.browserErrors = browserErrors;
    try {
      await use(api);
    } finally {
      await page.unroute("**/api/marketplace/**");
    }
  }
});

test.describe("DSH 插件市场 frontend browser contract", () => {
  test("characterize: 挂载市场并呈现安装状态", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.setVariant("list", "legacy");
    await openMarketplace(page, host.url);

    await expect(page.getByRole("heading", { name: "DSH插件市场", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "web", exact: true })).toHaveValue("web");
    await expect(page.getByText("共 3 个插件", { exact: true })).toBeVisible();
    await expect(page.getByText(/fixture-ready\s*★\s*12/)).toBeVisible();
    await expect(page.getByText(/fixture-installed\s*★\s*8/)).toBeVisible();
    await expect(page.getByText(/fixture-manual\s*★\s*3/)).toBeVisible();
    await expect(page.getByRole("button", { name: "安装", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "已安装", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "不可安装", exact: true })).toHaveCount(1);
    expect(marketplaceApi.requests.filter((request) => request.path === "/api/marketplace/list")).toHaveLength(1);
    expect(marketplaceApi.browserErrors).toEqual([]);
  });

  test("characterize: legacy 安装响应仍完成安装", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.setVariant("list", "legacy");
    marketplaceApi.setVariant("install", "legacy");
    await openMarketplace(page, host.url);

    await page.getByRole("button", { name: "安装", exact: true }).click();
    await expect(page.getByText("fixture lifecycle confirmation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "允许", exact: true }).click();
    await expect(page.getByText(/安装完成/)).toBeVisible();
    expect(marketplaceApi.browserErrors).toEqual([]);
  });

  test("characterize: 在插件与 Skills 标签间切换", async ({ page, host, marketplaceApi }) => {
    await openMarketplace(page, host.url);

    await page.getByRole("button", { name: "通用 Skills", exact: true }).click();
    await expect(page.getByRole("heading", { name: "通用 Skills", exact: true })).toBeVisible();
    await expect(page.getByText("共 2 个 Skills", { exact: true })).toBeVisible();
    expect(marketplaceApi.requests.filter((request) => request.path === "/api/marketplace/skills")).toHaveLength(2);
    await expect(page.getByText(/fixture-skill\s*★\s*4/)).toBeVisible();
    await expect(page.getByText(/fixture-skill-two\s*★\s*2/)).toBeVisible();
    await expect(page.getByText(/fixture-ready\s*★/)).toHaveCount(0);

    await page.getByRole("button", { name: "DSH 插件", exact: true }).click();
    await expect(page.getByRole("heading", { name: "DSH插件市场", exact: true }).last()).toBeVisible();
    await expect(page.getByText(/fixture-ready\s*★/)).toBeVisible();
  });

  test("characterize: 搜索空结果并从失败状态重试", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.setVariant("list", "forward");
    marketplaceApi.failNext("list");
    await openMarketplace(page, host.url);

    await expect(page.getByText("加载失败: fixture list unavailable", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByText(/fixture-ready\s*★/)).toBeVisible();

    const search = page.getByPlaceholder("搜索插件名（如 pdf、image、ppt）...");
    await search.fill("ready");
    await expect(page.getByText(/fixture-installed\s*★/)).toHaveCount(0);
    await expect(page.getByText("没有匹配「ready」的插件", { exact: true })).toHaveCount(0);

    await search.fill("missing");
    await expect(page.getByText("没有匹配「missing」的插件", { exact: true })).toBeVisible();
  });

  test("characterize: 生命周期确认拒绝显示取消结果", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.setVariant("install", "forward");
    await openMarketplace(page, host.url);

    await page.getByRole("button", { name: "安装", exact: true }).click();
    await expect(page.getByText("fixture lifecycle confirmation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "不允许（取消安装）", exact: true }).click();
    await expect(page.getByText("安装已取消", { exact: true })).toBeVisible();

    expect(marketplaceApi.installRequests).toEqual([
      { repo: "fixture-owner/fixture-ready", answers: {} },
      { repo: "fixture-owner/fixture-ready", answers: { __confirm_npm_scripts__: "deny" } }
    ]);
    expect(marketplaceApi.browserErrors).toEqual([]);
  });

  test("characterize: 网络中断后重试恢复列表", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.abortNext("list");
    await openMarketplace(page, host.url);

    await expect(page.getByText(/加载失败/)).toBeVisible();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByText(/fixture-ready\s*★/)).toBeVisible();
  });

  test("characterize: 刷新请求进行中按钮禁用", async ({ page, host, marketplaceApi }) => {
    marketplaceApi.hangNext("list");
    await openMarketplace(page, host.url);

    const refresh = page.getByRole("button", { name: "刷新", exact: true });
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(page.getByRole("button", { name: "正在刷新 ...", exact: true })).toBeDisabled();
  });

  test("characterize: 保存 profile 后 reload 仍重新挂载", async ({ page, host, marketplaceApi }) => {
    await openMarketplace(page, host.url);

    const profile = page.getByRole("textbox", { name: "web", exact: true });
    await profile.fill("desktop");
    await profile.locator("..").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("目标 profile 已设为 desktop", { exact: true })).toBeVisible();
    await expect(profile).toHaveValue("desktop");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByText("DSH插件市场", { exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "DSH插件市场", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "web", exact: true })).toHaveValue("desktop");
    await expect(page.getByText("共 3 个插件", { exact: true })).toBeVisible();
    expect(marketplaceApi.requests.filter((request) => request.path === "/api/marketplace/list")).toHaveLength(2);
  });
});
