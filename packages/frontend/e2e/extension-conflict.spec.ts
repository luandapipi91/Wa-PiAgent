import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 插件注册面冲突 E2E：在设置 → 插件页真实安装两个「注册同名命令」的本地插件，
// 第二个应被 kernel 拦下并在界面上给出可读提示（而不是静默共存）。
//
// 用本地包而非 npm 包：安装不联网、秒级完成，且不需要真实 pi 进程
// （冲突校验发生在 kernel 写 settings.json 之前），因此无需 PI_E2E 门控。
// 截图清理：本 spec 不落盘任何截图；临时插件包在 afterAll 删除。

/** 造一个注册指定命令的本地 pi 扩展包，返回包目录与包名 */
function makeLocalPkg(cmd: string): { root: string; name: string } {
  const suffix = randomUUID().slice(0, 8);
  const name = `e2e-conflict-${suffix}`;
  const root = join(process.env.TEMP ?? "/tmp", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name, version: "1.0.0", pi: { extensions: ["./index.ts"] } },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "index.ts"),
    `export default function (pi) {\n  pi.registerCommand("${cmd}", { description: "d", handler: async () => {} });\n}\n`,
    "utf8",
  );
  return { root, name };
}

/** 预置 ui-prefs localStorage 锁定中文（extension-repair.spec.ts 同款） */
async function setZh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "wa-pi-ui-prefs",
      JSON.stringify({
        state: { language: "zh", fontSize: 16, exportTurns: 1 },
        version: 0,
      }),
    );
  });
}

/** 打开设置 → 插件页 */
async function openSettingsPlugins(page: Page, tag: string) {
  await saveProvider({
    id: `e2e-ext-conflict-provider-${tag}`,
    name: "E2E Conflict",
    slug: `e2e_ext_conflict_${tag}`,
    baseUrl: "http://localhost:9999/v1",
    apiKey: "sk-e2e",
    api: "openai-completions",
    models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
  });
  await page.goto("/");
  await createProject(
    `e2e-ext-conflict-${tag}`,
    `/tmp/e2e-ext-conflict-${tag}`,
  );
  await page.goto("/");
  await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await expect(page.getByTestId("ext-install-input")).toBeVisible();
}

async function installViaUi(page: Page, dir: string) {
  await page.getByTestId("ext-install-input").fill(dir);
  await page.getByTestId("ext-install-btn").click();
}

test("注册面冲突：装第二个同命令插件被拦并提示", async ({ page }) => {
  const tag = randomUUID().slice(0, 6);
  // 两个包都注册同一命令 → 第二个安装必须被拦
  const alpha = makeLocalPkg("e2e-dup-cmd");
  const beta = makeLocalPkg("e2e-dup-cmd");
  try {
    await setZh(page);
    await openSettingsPlugins(page, tag);

    // 第一个：正常安装（卡片出现即成功）
    await installViaUi(page, alpha.root);
    await expect(page.getByTestId(`ext-card-${alpha.name}`)).toBeVisible({
      timeout: 30_000,
    });

    // 第二个：被拦下 → 界面给出可读冲突提示
    await installViaUi(page, beta.root);
    await expect(page.getByText(/都注册了命令/)).toBeVisible({
      timeout: 30_000,
    });
    // 冲突包不得出现在插件列表里
    await expect(page.getByTestId(`ext-card-${beta.name}`)).toHaveCount(0);
  } finally {
    rmSync(alpha.root, { recursive: true, force: true });
    rmSync(beta.root, { recursive: true, force: true });
  }
});

test("注册面不重叠：两个插件可共存", async ({ page }) => {
  const tag = randomUUID().slice(0, 6);
  const alpha = makeLocalPkg("e2e-cmd-a");
  const beta = makeLocalPkg("e2e-cmd-b");
  try {
    await setZh(page);
    await openSettingsPlugins(page, tag);

    await installViaUi(page, alpha.root);
    await expect(page.getByTestId(`ext-card-${alpha.name}`)).toBeVisible({
      timeout: 30_000,
    });
    await installViaUi(page, beta.root);
    await expect(page.getByTestId(`ext-card-${beta.name}`)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    rmSync(alpha.root, { recursive: true, force: true });
    rmSync(beta.root, { recursive: true, force: true });
  }
});
