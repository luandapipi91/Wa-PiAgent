// 存量会话历史加载 E2E（第四层）：打开已有会话 → 历史消息在浏览器中渲染
//
// 背景：session:messages 旧路径要冷启动 pi 进程才能拿历史（数秒）；
// 现为文件直读快速路径（毫秒级）+ 后台预热进程。本 spec 验证真实浏览器中
// 打开存量会话的完整链路可用，并记录从点击到历史可见的耗时。
//
// 数据准备：直接向 E2E 隔离 WA_PI_DIR 写 projects.json 会话记录 + pi 会话文件
// （kernel 的 projectStore 每次请求重新 load，文件改动即生效）。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider, setUiPrefs } from "./helpers";

const SESSION_ID = "s-e2e-history-001";

function seedExistingSession() {
  const projPath = join(E2E_WA_PI_DIR, "projects.json");
  const data = JSON.parse(readFileSync(projPath, "utf8"));
  if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
    data.sessions.push({
      id: SESSION_ID,
      projectId: "e2e-proj-1",
      primaryAgent: "dev",
      title: "E2E存量会话",
      createdAt: 1,
      lastActivity: 1,
      piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
    });
    writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
  }
  mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
  const line = (id: string, parentId: string | null, role: string, text: string, ts: number) =>
    JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }], timestamp: ts } });
  writeFileSync(join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: "e2e-history-uuid" }),
    line("m1", null, "user", "E2E历史问题", 1),
    line("m2", "m1", "assistant", "E2E历史回答", 2),
  ].join("\n"), "utf8");
}

test("存量会话：点击会话行 → 历史消息渲染（秒开）", async ({ page }) => {
  test.setTimeout(60_000);
  seedExistingSession();

  // seed + 预置 ui-prefs 须在首个 goto 之前（否则向导/主题引导弹窗挡点击）
  await saveProvider({
    id: "e2e-session-history-provider",
    name: "E2E History",
    slug: "e2e-session-history",
    baseUrl: "http://localhost:9999/v1",
    apiKey: "sk-e2e",
    api: "openai-completions",
    models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
  });
  await setUiPrefs(page, "zh");

  await page.goto("/");
  const row = page.getByTestId(`session-${SESSION_ID}`);
  await expect(row).toBeVisible({ timeout: 10_000 });

  const t0 = Date.now();
  await row.click();

  // 历史消息渲染：用户气泡 + assistant 文本块
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("E2E历史问题")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("E2E历史回答")).toBeVisible({ timeout: 10_000 });
  const elapsed = Date.now() - t0;
  console.log(`[e2e] 打开存量会话到历史可见耗时: ${elapsed}ms`);
  // 性能红线：文件直读正常时 <1s；给 CI 留 20x 余量。旧进程冷启动路径在隔离环境也要 ~2s+
  expect(elapsed).toBeLessThan(20_000);
});
