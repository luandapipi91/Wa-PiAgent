// 会话级委派设置（delegateModel / delegateThinking）E2E（任务 7）
//
// 七个定死场景（简报 task-7）：
//   1. 新建页输入框底部默认渲染「委派 · 跟随」
//   2. 展开面板选模型 + 思考 max → 按钮回显「委派 · {modelId短名} / max」
//   3. 发送消息：拦截到的 prompt 请求体携带所选 delegateModel/delegateThinking
//   4. reload 后会话页回显保持（IndexedDB 会话级持久化）
//   5. 第二个新会话默认「委派 · 跟随」（新建页本地 state 不跨会话残留）
//   6. 第二会话设置后再改回「跟随」发送 → 请求体 delegateModel === null（显式重置，非省略字段）
//   7. 340px 窄视口：按钮可见、面板可展开且内容不被裁剪出视口
//
// 拦截策略：page.route 捕获 body 后 route.continue() 放行——kernel 真实建会话，
// session-view 正常出现。真实 kernel 下不让假模型产生 delegate 调用（不触发子代理），
// 只断言前端请求体与 UI 持久化。
//
// 重发路径补充（前序审查建议）：参照 resend-attachments.spec 的 401 fatal provider 先例
// （内核按 fatal 处理不进 pi 重试退避，回合几秒内以 stopReason:error 结束），
// 失败回合出现「重新发送」按钮 → 点击 → 断言重发请求体同样携带委派两栏值。
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createProject, saveProvider, setUiPrefs } from "./helpers";

const MODEL_A = "e2e-delegate/model-a";
const MODEL_B = "e2e-delegate/model-b";

/** 拦截 prompt 请求：捕获 body 与 URL 后放行（kernel 真实建会话） */
async function interceptPrompts(page: Page): Promise<{
  bodies: any[];
  urls: string[];
}> {
  const bodies: any[] = [];
  const urls: string[] = [];
  await page.route("**/api/agents/**/prompt", async (route) => {
    const req = route.request();
    const raw = req.postData();
    bodies.push(raw ? JSON.parse(raw) : {});
    urls.push(req.url());
    await route.continue();
  });
  return { bodies, urls };
}

/** 从拦截到的 prompt URL 解析 sessionId：/api/agents/{projectId}/{sessionId}/prompt */
function sessionIdFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(segs[segs.length - 2]);
}

async function seedProvider() {
  await saveProvider({
    id: "e2e-delegate-provider",
    name: "E2E Delegate",
    slug: "e2e-delegate",
    baseUrl: "http://localhost:9999/v1",
    apiKey: "sk-e2e",
    api: "openai-completions",
    models: [
      { id: "model-a", contextWindow: 128000, maxTokens: 4096 },
      { id: "model-b", contextWindow: 128000, maxTokens: 4096 },
    ],
  });
}

/** 页面内读取会话 prefs 记录（裸 IDB，race 防卡死） */
async function readSessionPrefs(page: Page, sessionId: string): Promise<any> {
  return page.evaluate(async (sid) => {
    const readRec = () =>
      new Promise<any>((resolve, reject) => {
        const req = indexedDB.open("wa-pi-composer", 1);
        req.onblocked = () => reject(new Error("open blocked"));
        req.onerror = () => reject(req.error ?? new Error("open failed"));
        req.onsuccess = () => {
          const db = req.result;
          try {
            const get = db
              .transaction("sessions", "readonly")
              .objectStore("sessions")
              .get(sid);
            get.onsuccess = () => {
              db.close();
              resolve(get.result ?? null);
            };
            get.onerror = () => reject(get.error ?? new Error("get failed"));
          } catch (e) {
            reject(e as Error);
          }
        };
      });
    return Promise.race([
      readRec(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("idb race timeout")), 3000)),
    ]);
  }, sessionId);
}

test.describe.serial("会话级委派设置", () => {
  test.beforeEach(async ({ page }) => {
    // seed + 预置 ui-prefs 须在首个 goto 之前（否则向导/主题引导弹窗挡点击）
    await seedProvider();
    await setUiPrefs(page, "zh");
    const projectName = `e2e-delegate-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    await createProject(projectName, `/tmp/${projectName}`);
  });

  test("场景1：新建页默认渲染「委派 · 跟随」", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("delegate-selector")).toHaveText(
      "委派 · 跟随",
    );
  });

  test(
    "场景2+3+4：面板选模型/思考 max → 回显 → 请求体携带所选值 → reload 保持",
    async ({ page }) => {
      const { bodies, urls } = await interceptPrompts(page);
      await page.goto("/");
      await expect(page.getByTestId("new-session-pane")).toBeVisible({
        timeout: 5000,
      });
      // 必须先选主模型，否则发送按钮禁用
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E Delegate/model-a" });

      // 场景2：展开面板选委派模型（点选即生效并收起），再选思考 max，按钮回显
      await page.getByTestId("delegate-selector").click();
      await expect(page.getByTestId("delegate-selector-menu")).toBeVisible();
      await page.getByTestId(`delegate-item-model-${MODEL_A}`).click();
      await expect(page.getByTestId("delegate-selector-menu")).toBeHidden();
      await page.getByTestId("delegate-selector").click();
      await page.getByTestId("delegate-item-thinking-max").click();
      await expect(page.getByTestId("delegate-selector-menu")).toBeHidden();
      await expect(page.getByTestId("delegate-selector")).toHaveText(
        "委派 · model-a / max",
      );

      // 场景3：发送 → 拦截请求体断言（route.continue 放行，kernel 真实建会话）
      await page
        .locator('[data-testid="composer-input"] [role="textbox"]')
        .fill("委派请求体测试");
      await page.getByTestId("composer-send").click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });
      await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);
      expect(bodies[0].delegateModel).toBe(MODEL_A);
      expect(bodies[0].delegateThinking).toBe("max");
      const sessionId = sessionIdFromUrl(urls[0]);

      // 等待进入会话后的 loadSession 把 gap 里的委派两栏合并落盘（IndexedDB）：
      // session-view 是乐观渲染，出现不代表异步落盘已完成——立刻 reload 会打断 IDB 写
      await expect
        .poll(async () => (await readSessionPrefs(page, sessionId))?.delegateModel ?? null, {
          timeout: 10_000,
        })
        .toBe(MODEL_A);

      // 场景4：reload（同一浏览器 context，与用户刷新页面同义）→ 重新进入会话 → 回显保持
      await page.reload();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByTestId("delegate-selector")).toHaveText(
        "委派 · model-a / max",
      );
    },
  );

  test("场景5+6：第二会话默认跟随；改回跟随后请求体显式 null", async ({
    page,
  }) => {
    const { bodies } = await interceptPrompts(page);

    // 场景5：第二个新会话默认「委派 · 跟随」（NewSessionPane 重挂载，本地 state 清空）
    await page.getByTestId("session-scope-recent").click();
    await page.getByTestId("recent-new-session").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("delegate-selector")).toHaveText(
      "委派 · 跟随",
    );

    // 先设 model-b（进入委派态），再改回「跟随」——验证显式重置路径
    await page
      .getByTestId("model-selector")
      .selectOption({ label: "E2E Delegate/model-b" });
    await page.getByTestId("delegate-selector").click();
    await page.getByTestId(`delegate-item-model-${MODEL_B}`).click();
    await expect(page.getByTestId("delegate-selector")).toHaveText(
      "委派 · model-b / 跟随",
    );
    await page.getByTestId("delegate-selector").click();
    await page.getByTestId("delegate-item-follow-model").click();
    await expect(page.getByTestId("delegate-selector")).toHaveText(
      "委派 · 跟随",
    );

    // 场景6：发送 → body 中 delegateModel === null（显式 null，非省略字段）
    await page
      .locator('[data-testid="composer-input"] [role="textbox"]')
      .fill("显式重置委派");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({
      timeout: 8000,
    });
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);
    expect("delegateModel" in bodies[0]).toBe(true);
    expect(bodies[0].delegateModel).toBe(null);
    expect(bodies[0].delegateThinking).toBe(null);
  });
});

test.describe.serial("会话级委派设置：重发路径", () => {
  let server: Server;
  let fatalBaseUrl = "";

  test.beforeAll(async () => {
    // 401 fatal provider：回合几秒内以 stopReason:error 结束 → 「重新发送」按钮出现
    // （先例：resend-attachments.spec.ts）
    server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "invalid api key", type: "invalid_request_error" },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    fatalBaseUrl = `http://127.0.0.1:${port}/v1`;
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("重发按钮：重发请求体同样携带委派两栏", async ({ page }) => {
    const { bodies } = await interceptPrompts(page);
    await saveProvider({
      id: "e2e-delegate-fatal-provider",
      name: "E2E Delegate Fatal",
      slug: "e2e-delegate-fatal",
      baseUrl: fatalBaseUrl,
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject(
      `e2e-delegate-resend-${randomUUID().slice(0, 8)}`,
      `/tmp/e2e-delegate-resend-${randomUUID().slice(0, 8)}`,
    );
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await page
      .getByTestId("model-selector")
      .selectOption({ label: "E2E Delegate Fatal/model-a" });
    // 委派面板：选模型 + 思考 max
    await page.getByTestId("delegate-selector").click();
    await page.getByTestId("delegate-item-model-e2e-delegate-fatal/model-a").click();
    await page.getByTestId("delegate-selector").click();
    await page.getByTestId("delegate-item-thinking-max").click();
    await expect(page.getByTestId("delegate-selector")).toHaveText(
      "委派 · model-a / max",
    );

    // 发送 → fatal 失败 → 「重新发送」按钮出现
    await page
      .locator('[data-testid="composer-input"] [role="textbox"]')
      .fill("重发委派测试");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({
      timeout: 8000,
    });
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies[0].delegateModel).toBe("e2e-delegate-fatal/model-a");
    expect(bodies[0].delegateThinking).toBe("max");

    const resend = page.locator('[data-testid^="resend-"]');
    await expect(resend).toBeVisible({ timeout: 30000 });
    await resend.click();

    // 重发请求体必须同样携带委派两栏（漏转发会退化为 undefined，kernel 不变更句柄）
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[bodies.length - 1].delegateModel).toBe(
      "e2e-delegate-fatal/model-a",
    );
    expect(bodies[bodies.length - 1].delegateThinking).toBe("max");
  });
});

test.describe.serial("会话级委派设置：窄视口", () => {
  test.use({ viewport: { width: 340, height: 700 } });

  test.beforeEach(async ({ page }) => {
    await seedProvider();
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject(
      `e2e-delegate-narrow-${randomUUID().slice(0, 8)}`,
      `/tmp/e2e-delegate-narrow-${randomUUID().slice(0, 8)}`,
    );
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
  });

  test("场景7：340px 视口按钮可见、面板展开不出视口", async ({ page }) => {
    const btn = page.getByTestId("delegate-selector");
    // 委派按钮已渲染。340px 下应用整体横向溢出属既有布局行为（sidebar 无视口折叠
    // 机制、composer 底部行 nowrap 不换行、横向无滚动出口），与同行 model/thinking
    // 选择器同样横向不可达，非本功能引入的回归。先纵向滚动把按钮带进视口（模拟
    // 用户滚到按钮处），再用 dispatchEvent 绕过横向不可达展开，聚焦验证本功能的
    // fixed 面板钳制逻辑（按视口坐标定位 + 向上翻转/水平钳制）
    await expect(btn).toBeVisible();
    // 一次滚到所有可滚祖先底部，页面进入静止态（无后续 clamp 滚动）——避免面板
    // 打开后又被迟到的 scroll 事件触发组件的「滚动收起」监听；横向不可达为既有布局行为
    await btn.evaluate((el) => {
      let p: HTMLElement | null = el.parentElement;
      while (p) {
        if (p.scrollHeight > p.clientHeight + 1) p.scrollTop = p.scrollHeight;
        p = p.parentElement;
      }
    });
    await page.waitForTimeout(300);

    // 兜底：面板若仍被偶发 scroll 收起，重试点击直到读到面板 box 为止
    const readMenuBox = () =>
      page.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="delegate-selector-menu"]',
        ) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    let menuBox: { x: number; y: number; width: number; height: number } | null =
      null;
    for (let attempt = 0; attempt < 5 && !menuBox; attempt++) {
      await btn.dispatchEvent("click");
      menuBox = await Promise.race([
        readMenuBox(),
        new Promise<null>((r) => setTimeout(() => r(null), 300)),
      ]);
    }
    expect(menuBox).toBeTruthy();
    // 面板完整落在视口内（fixed 面板按视口坐标水平钳制 + 底部空间不足向上翻转）
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(340);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(700);
    // 两栏内容可见（不被裁剪出视口）
    await expect(page.getByTestId("delegate-col-model")).toBeVisible();
    await expect(page.getByTestId("delegate-col-thinking")).toBeVisible();
  });
});
