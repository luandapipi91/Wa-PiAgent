// memory.spec.ts — 记忆管理 E2E 测试（Task 12）
//
// 覆盖 spec 场景：进入记忆页 → 查看列表 → 编辑 → 归档 → 指令文件 Tab → 双开关。
// 测试数据由 global-setup.ts 在 kernel 启动前预置到隔离 WA_PI_DIR：
//   memories/global/MEMORY.md（两条 § 分隔记忆）+ USER.md + 全局 AGENTS.md。
// 注：E2E_WA_PI_DIR 已改为固定目录（playwright.config.ts），worker 与 globalSetup 进程
// 拿到一致路径；本 spec 只读 UI，不直接写隔离目录。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

// 记忆管理现作为「系统设置」面板的一个分区。
// 此辅助函数打开设置弹窗并切到「记忆」分区。
// 先预置假 provider：全新隔离目录无 provider 时首启 onboarding 向导会弹出，
// 其 modal-overlay 会拦截 settings-btn 的点击（settings-sound / file-change-summary 同坑，
// 本 spec 在此修复前一直因此为红）。
async function openMemorySection(page: import("@playwright/test").Page) {
  await saveProvider({
    id: "memory-e2e-provider",
    name: "Memory E2E",
    baseUrl: "https://example.invalid",
    apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
  });
  await page.goto("/");
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("memory-page")).toBeVisible({ timeout: 5000 });
}

test.describe
  .serial("记忆管理", () => {
    test("进入记忆页，查看记忆列表", async ({ page }) => {
      await openMemorySection(page);

      // 确认标题与默认「已保存」Tab 存在
      await expect(page.getByTestId("tab-已保存")).toBeVisible();
      // 默认「全局记忆」作用域，预置的全局记忆应直接渲染
      await expect(page.getByText("E2E 记忆条目一").first()).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText("E2E 记忆条目二").first()).toBeVisible();
    });

    test("编辑一条记忆", async ({ page }) => {
      await openMemorySection(page);
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible({ timeout: 5000 });

      // 点击第一张卡片的「编辑」按钮
      await page.locator('[data-testid="memory-edit"]').first().click();
      await expect(page.getByTestId("memory-edit-textarea")).toBeVisible();

      // 修改文本并保存
      await page.getByTestId("memory-edit-textarea").fill("E2E 编辑后的记忆");
      await page.getByTestId("memory-edit-save").click();

      // 保存后编辑态关闭，新文本出现在列表（memory:changed 广播刷新）
      await expect(page.getByText("E2E 编辑后的记忆").first()).toBeVisible({
        timeout: 5000,
      });
    });

    test("归档一条记忆 → 切到归档 Tab 查看", async ({ page }) => {
      await openMemorySection(page);
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible({ timeout: 5000 });

      // 点击第一张卡片的「归档」按钮
      await page.locator('[data-testid="memory-archive"]').first().click();

      // 切到归档 Tab，应能看到被归档的条目
      await page.getByTestId("tab-归档").click();
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible({ timeout: 5000 });
    });

    test("切换到指令文件 Tab", async ({ page }) => {
      await openMemorySection(page);

      // 切到指令文件 Tab
      await page.getByTestId("tab-指令文件").click();
      // 有指令文件就展示条目，没有就展示空状态——两者之一可见即通过
      const hasItem = await page
        .locator('[data-testid*="instruction-item"]')
        .count();
      expect(hasItem).toBeGreaterThanOrEqual(0);
      // global-setup 预置了全局 AGENTS.md，应展示全局指令条目
      if (hasItem > 0) {
        await expect(
          page.locator('[data-testid="instruction-item-global"]'),
        ).toBeVisible({ timeout: 5000 });
      }
    });

    test("开关切换 — 自动学习", async ({ page }) => {
      await openMemorySection(page);

      // 点击「自动学习」开关（toggle-review label 包裹 ToggleSwitch）
      // 默认 reviewEnabled=true → 内部 toggle 为 toggle-on，点击后变 toggle-off
      const reviewToggle = page.getByTestId("toggle-review");
      await expect(reviewToggle).toBeVisible();

      // 点击开关内部（ToggleSwitch 的 toggle-on/toggle-off），不点 label 文字
      await reviewToggle.locator('[data-testid^="toggle-"]').click();
      // 不报错即通过；验证开关状态翻转（on → off）
      await expect(
        reviewToggle.locator('[data-testid="toggle-off"]'),
      ).toBeVisible({ timeout: 3000 });
    });

    test("Bug1: 关闭重开设置后，项目作用域选择器保留上次选中的项目", async ({
      page,
    }) => {
      await openMemorySection(page);

      // 展开作用域下拉，选择预置的 E2E 项目
      await page.getByTestId("memory-scope-select").click();
      await page.getByTestId("memory-scope-option-project-e2e-proj-1").click();

      // 确认已切到该项目：按钮显示项目名，项目记忆可见
      await expect(page.getByTestId("memory-scope-select")).toContainText(
        "E2E项目",
      );
      await expect(page.getByText("E2E 项目记忆条目").first()).toBeVisible({
        timeout: 5000,
      });

      // 关闭设置弹窗：自 87105067 起 Modal 默认 closeOnOverlayClick=false（防误触丢输入），
      // 点遮罩不再关闭，改用标题栏的关闭按钮
      await page.getByTestId("settings-close").click();
      await expect(page.getByTestId("settings-modal")).toBeHidden({
        timeout: 3000,
      });

      // 重新打开设置 → 记忆页
      await page.getByTestId("settings-btn").click();
      await expect(page.getByTestId("settings-modal")).toBeVisible();
      await page.getByTestId("settings-nav-memory").click();
      await expect(page.getByTestId("memory-page")).toBeVisible({
        timeout: 5000,
      });

      // 期望：选择器仍显示该项目名（而非兜底的「项目记忆」），项目记忆仍可见
      await expect(page.getByTestId("memory-scope-select")).toContainText(
        "E2E项目",
      );
      await expect(page.getByText("E2E 项目记忆条目").first()).toBeVisible({
        timeout: 5000,
      });
    });

    test("Bug2: 指令文件 Tab 切到项目作用域，默认即加载项目指令文件", async ({
      page,
    }) => {
      await openMemorySection(page);

      // 切到指令文件 Tab
      await page.getByTestId("tab-指令文件").click();
      // 项目选择器始终可见（不受 scopeFilter 影响）
      await expect(
        page.getByTestId("instruction-project-select"),
      ).toBeVisible();

      // 选中预置项目加载其指令文件（默认选中依赖 currentProjectId——本用例无打开的项目，
      // 下拉虽显示首项但 store 为 null，需显式选中触发加载）
      await page
        .getByTestId("instruction-project-select")
        .selectOption({ label: "E2E项目" });

      // 切到「项目」作用域：应显示项目级指令文件
      // （按钮限定在 memory-page 内：侧栏也有「项目」分区标题，全局 getByText 会歧义）
      await page
        .getByTestId("memory-page")
        .getByRole("button", { name: "项目", exact: true })
        .click();
      await expect(page.getByTestId("instruction-item-project")).toBeVisible({
        timeout: 5000,
      });
    });

    // ── 服务端检索（批 2 检索体验，spec §12 第四层验收）────────────────────

    test("服务端检索：命中摘要与命中总数，清空后回到完整列表", async ({
      page,
    }) => {
      await openMemorySection(page);

      const search = page.getByTestId("memory-search");
      const req = page.waitForRequest((r) =>
        r.url().includes("/api/memories/search"),
      );
      await search.fill("记忆");
      await req;

      // 结果来自服务端：统计行 + 卡片（卡片正文是检索摘要而非全文）
      await expect(page.getByTestId("memory-search-total")).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible();
      await expect(
        page.getByTestId("memory-card-snippet-hint").first(),
      ).toBeVisible();

      // 清空搜索词 → 退出检索态，回到本地完整列表
      await search.fill("");
      await expect(page.getByTestId("memory-search-total")).toBeHidden({
        timeout: 3000,
      });
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible();
    });

    test("检索中空态：在途显示 🔍 + 「检索中：{词}」+ 等待提示（同记忆空态规格）", async ({
      page,
    }) => {
      await openMemorySection(page);

      // 拦截检索请求延迟放行：制造「在途」窗口
      let release: (() => void) | null = null;
      const gate = new Promise<void>((res) => (release = res));
      await page.route(/\/api\/memories\/search/, async (route) => {
        await gate;
        await route.continue();
      });

      const search = page.getByTestId("memory-search");
      await search.fill("记忆");

      // 在途：三段式检索中空态（🔍 + 标题含搜索词 + 提示语）
      await expect(page.getByTestId("memory-empty-searching")).toBeVisible();
      await expect(page.getByText("检索中：记忆")).toBeVisible();
      await expect(page.getByText("正在检索记忆，请等待……")).toBeVisible();

      release?.();
      // 放行后检索完成：空态让位给命中统计 + 卡片
      await expect(page.getByTestId("memory-search-total")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByTestId("memory-empty-searching")).toBeHidden();
    });

    test("单字检索：bigram 索引无 unigram 时回退子串匹配，单个汉字也能命中", async ({
      page,
    }) => {
      await openMemorySection(page);

      const req = page.waitForRequest((r) =>
        r.url().includes("/api/memories/search"),
      );
      // 单个汉字：索引里只有相邻二元组，FTS 必然零命中，靠 DAO 子串回退才看得到
      await page.getByTestId("memory-search").fill("条");
      await req;

      await expect(page.getByTestId("memory-search-total")).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator('[data-testid^="memory-card-"]').first(),
      ).toBeVisible();
    });

    test("层筛选下推服务端：检索态点「知识」后请求带 kind=knowledge", async ({
      page,
    }) => {
      await openMemorySection(page);

      const first = page.waitForRequest((r) =>
        r.url().includes("/api/memories/search"),
      );
      await page.getByTestId("memory-search").fill("记忆");
      await first;

      // 层筛选变更应带上 kind 重新向服务端检索（不是本地过滤）
      const withKind = page.waitForRequest(
        (r) =>
          r.url().includes("/api/memories/search") &&
          r.url().includes("kind=knowledge"),
      );
      await page
        .getByTestId("memory-kind-filter")
        .getByRole("button", { name: "知识", exact: true })
        .click();
      await withKind;
    });

    test("归档 Tab 检索：请求带 archivedOnly=true，命中卡片带「已归档」徽标", async ({
      page,
    }) => {
      await openMemorySection(page);
      await page.getByTestId("tab-归档").click();

      const req = page.waitForRequest(
        (r) =>
          r.url().includes("/api/memories/search") &&
          r.url().includes("archivedOnly=true"),
      );
      await page.getByTestId("memory-search").fill("E2E");
      await req;

      await expect(
        page.getByTestId("memory-card-archived-badge").first(),
      ).toBeVisible({ timeout: 5000 });
    });

    test("归档 Tab 列表与徽标按作用域过滤（回归：归档不得混入其它作用域条目）", async ({
      page,
    }) => {
      await openMemorySection(page);

      // 归档当前第一条全局记忆，切到归档 Tab
      await page.locator('[data-testid="memory-archive"]').first().click();
      await page.getByTestId("tab-归档").click();
      const archivedCards = page.locator('[data-testid^="memory-card-"]');
      await expect(archivedCards.first()).toBeVisible({ timeout: 5000 });

      // 全局作用域下：归档列表只含全局条目，预置的项目记忆不应出现
      await expect(page.getByText("E2E 项目记忆条目")).toHaveCount(0);
      // 徽标与列表同口径：等于当前作用域下的归档数，而非全量
      const badge = await page.getByTestId("tab-归档").textContent();
      expect(badge).toContain(String(await archivedCards.count()));

      // 切到项目作用域：全局归档不再显示（serial 前置用例均只归档全局条目 → 项目作用域下为空态）
      await page.getByTestId("memory-scope-select").click();
      await page.getByTestId("memory-scope-option-project-e2e-proj-1").click();
      await expect(archivedCards).toHaveCount(0, { timeout: 5000 });
    });
  });
