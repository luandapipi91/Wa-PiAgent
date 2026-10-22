import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { addSkillDir, createProject, getBuiltinSkill, removeSkillDir, ensureProvider, setUiPrefs } from "./helpers";

test.describe.serial("技能管理", () => {
  test.beforeAll(async () => {
    // 无 provider 时首启会弹 onboarding 向导（modal-overlay 遮挡点击，冷内核单独跑必挂）
    await ensureProvider();
  });

  test("打开设置 → 技能菜单", async ({ page }) => {
    // 断言中文界面（headless 默认 navigator=en-US 会渲染英文）
    await setUiPrefs(page, "zh");
    await page.goto("/");
    // 预置项目（复用 app-flow 模式）
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    // 切到技能菜单
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）
    await expect(page.getByTestId("skill-dir-toggle")).toBeVisible();
    // 技能列表区已渲染（UI 已改为分组 + 搜索框形态，原「已加载技能」标题不存在）
    await expect(page.getByTestId("skill-search-input")).toBeVisible();
  });

  test("技能目录默认折叠，展开后显示目录行且无删除按钮", async ({ page }) => {
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）

    // 技能目录现默认折叠：不点 toggle 时目录列表不渲染
    await expect(page.locator('[data-testid^="skill-dir-open-"]')).toHaveCount(0);
    await page.getByTestId("skill-dir-toggle").click();
    // 展开后内置目录行存在且范围标签为 [全局]（改造后由原 [内置] 更名），目录区不再有删除按钮
    await expect(page.getByText("[全局]")).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid^="skill-dir-remove-"]')).toHaveCount(0);
  });

  test("禁用技能 + 启用技能", async ({ page }) => {
    // 直接向 E2E 隔离的内置技能目录注入技能（技能目录增删接口已下线，
    // helper 改为写 <WA_PI_DIR>/skills/test-skill 并轮询等 kernel 扫到）
    await addSkillDir("test-skill", "测试技能");

    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）

    // 等待技能出现
    await expect(page.getByText("test-skill")).toBeVisible({ timeout: 5000 });

    // 禁用（禁用标签现渲染在技能行内，文案无方括号）
    const skillRow = page.getByTestId("skill-row-test-skill");
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(skillRow.getByText("禁用")).toBeVisible({ timeout: 5000 });

    // 启用
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(skillRow.getByText("禁用")).toHaveCount(0, { timeout: 5000 });

    // 清理：移除注入的技能
    await removeSkillDir("test-skill");
  });

  test("范围选择器与刷新按钮同一行，且范围选择器在刷新按钮左侧", async ({ page }) => {
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click();

    // 两者都属于「技能目录」行容器
    const header = page.getByTestId("skill-dir-header");
    await expect(header).toBeVisible();
    const scope = header.getByTestId("skill-scope-select");
    const refresh = header.getByTestId("skill-refresh-btn");
    await expect(scope).toBeVisible();
    await expect(refresh).toBeVisible();

    const scopeBox = await scope.boundingBox();
    const refreshBox = await refresh.boundingBox();
    expect(scopeBox).toBeTruthy();
    expect(refreshBox).toBeTruthy();
    // 同一行：纵向中心基本一致
    const scopeMid = scopeBox!.y + scopeBox!.height / 2;
    const refreshMid = refreshBox!.y + refreshBox!.height / 2;
    expect(Math.abs(scopeMid - refreshMid)).toBeLessThanOrEqual(6);
    // 范围选择器在刷新按钮左侧
    expect(scopeBox!.x + scopeBox!.width).toBeLessThanOrEqual(refreshBox!.x + 1);
  });
});

// 技能范围筛选：项目级技能（<project.cwd>/.pi/skills）的可见性与来源标签。
// 项目根全部落在 E2E 隔离目录内，不污染真实 HOME。
test.describe.serial("技能范围：项目级技能", () => {
  const PROJ_A_CWD = join(E2E_WA_PI_DIR, "e2e-scope-proj-a");
  const PROJ_B_CWD = join(E2E_WA_PI_DIR, "e2e-scope-proj-b");
  const SKILL_NAME = "e2e-scope-skill";
  const BUILTIN_NAME = "e2e-scope-builtin"; // 内置对照面：项目范围下不应出现
  const SKILL_DIR = join(PROJ_A_CWD, ".pi", "skills", SKILL_NAME);

  test.beforeAll(async () => {
    await ensureProvider();
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(
      join(SKILL_DIR, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: 项目级范围测试技能\n---\n# ${SKILL_NAME}`,
      "utf8",
    );
    mkdirSync(PROJ_B_CWD, { recursive: true });
  });

  test.afterAll(async () => {
    rmSync(join(PROJ_A_CWD, ".pi"), { recursive: true, force: true });
    rmSync(join(PROJ_B_CWD, ".pi"), { recursive: true, force: true });
  });

  test("切到某项目后列出该项目技能 + 全局技能；切到无该目录的项目则该项目技能消失", async ({ page }) => {
    const projA = await createProject("e2e-scope-A", PROJ_A_CWD);
    const projB = await createProject("e2e-scope-B", PROJ_B_CWD);
    await setUiPrefs(page, "zh");
    // 注入一个内置技能作为「全局来源始终可见」的对照面（新口径下选中项目会带出全局技能）
    await addSkillDir(BUILTIN_NAME, "内置对照技能");
    try {
      await page.goto("/");
      await page.getByTestId("settings-btn").click();
      await page.getByText("技能", { exact: true }).click();

      await page.getByTestId("skill-scope-select").click();
      await page.getByTestId(`skill-scope-option-project-${projA.id}`).click();
      const row = page.getByTestId(`skill-row-${SKILL_NAME}`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.getByText(`项目 skill（e2e-scope-A）`)).toBeVisible();
      // 选中项目下全局（内置）技能一并带出
      await expect(page.getByTestId(`skill-row-${BUILTIN_NAME}`)).toBeVisible({
        timeout: 5000,
      });

      await page.getByTestId("skill-scope-select").click();
      await page.getByTestId(`skill-scope-option-project-${projB.id}`).click();
      // 切到无该目录的项目：该项目技能消失，全局技能仍在
      await expect(page.getByTestId(`skill-row-${SKILL_NAME}`)).toHaveCount(0);
      await expect(page.getByTestId(`skill-row-${BUILTIN_NAME}`)).toBeVisible({
        timeout: 5000,
      });
    } finally {
      await removeSkillDir(BUILTIN_NAME).catch(() => {});
    }
  });

  test("同名时项目那条生效，选中该项目只显示一行", async ({ page }) => {
    const projA = await createProject("e2e-scope-A", PROJ_A_CWD);
    await setUiPrefs(page, "zh");
    await addSkillDir(SKILL_NAME, "内置同名版本");
    try {
      // 先显式确认前提：内置同名条目已进入 allSkills（addSkillDir 的等待已收紧到 builtin
      // 来源，这里再直查一次做独立证据）；否则「项目那条生效」的优先级断言会失去对照面
      expect(
        await getBuiltinSkill(SKILL_NAME),
        `内置来源的 ${SKILL_NAME} 应已进入 allSkills`,
      ).toBeTruthy();
      await page.goto("/");
      await page.getByTestId("settings-btn").click();
      await page.getByText("技能", { exact: true }).click();
      // 选中项目 A：同名以项目版本呈现，被遮蔽的内置版本不再列出
      await page.getByTestId("skill-scope-select").click();
      await page.getByTestId(`skill-scope-option-project-${projA.id}`).click();
      const rows = page.getByTestId(`skill-row-${SKILL_NAME}`);
      await expect(rows).toHaveCount(1);
      await expect(rows.getByText(`项目 skill（e2e-scope-A）`)).toBeVisible();
    } finally {
      await removeSkillDir(SKILL_NAME).catch(() => {});
    }
  });
});

// $ 快捷菜单（聊天输入框）的技能候选按「当前项目实际可用的技能」派生：
// 他项目技能不得出现（否则选中插入的 /skill:X 在该会话 spawn 时未传给 pi，静默不生效）。
test.describe.serial("技能范围：$ 快捷菜单按当前项目过滤", () => {
  const PROJ_A_CWD = join(E2E_WA_PI_DIR, "e2e-menu-proj-a");
  const PROJ_B_CWD = join(E2E_WA_PI_DIR, "e2e-menu-proj-b");
  const A_SKILL = "e2e-menu-a-skill";
  const B_SKILL = "e2e-menu-b-skill";

  /** 在项目根写一个项目技能：<cwd>/.pi/skills/<name>/SKILL.md */
  function writeProjectSkill(cwd: string, name: string, description: string): void {
    const dir = join(cwd, ".pi", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
      "utf8",
    );
  }

  test.beforeAll(async () => {
    await ensureProvider();
    writeProjectSkill(PROJ_A_CWD, A_SKILL, "项目 A 的技能");
    writeProjectSkill(PROJ_B_CWD, B_SKILL, "项目 B 的技能");
  });

  test.afterAll(() => {
    rmSync(join(PROJ_A_CWD, ".pi"), { recursive: true, force: true });
    rmSync(join(PROJ_B_CWD, ".pi"), { recursive: true, force: true });
  });

  test("选中项目 B 后 $ 菜单只列项目 B 的技能，来源标签带项目名", async ({ page }) => {
    // 两个项目都要注册（否则「项目 A 技能被排除」的断言无对照面）
    await createProject("e2e-menu-A", PROJ_A_CWD);
    const projB = await createProject("e2e-menu-B", PROJ_B_CWD);
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await page.getByTestId("project-select").selectOption(projB.id);

    const textbox = page.locator(
      '[data-testid="composer-input"] [role="textbox"]',
    );
    await textbox.click();
    await page.keyboard.type("$", { delay: 5 });

    const menu = page.getByTestId("quick-invoke-menu");
    await expect(menu).toBeVisible({ timeout: 5000 });
    // 本项目技能在列，且来源标签为「项目 skill（项目名）」口径
    await expect(menu).toContainText(B_SKILL, { timeout: 8000 });
    await expect(menu).toContainText("项目 skill（e2e-menu-B）");
    // 他项目技能不得出现
    await expect(menu).not.toContainText(A_SKILL);
  });
});

// 范围选择器菜单：改经 createPortal 挂到 body + fixed 定位，修「被 SkillSection 滚动容器
// 裁切（只露上半截）」与「把容器撑出滚动条」两个缺陷。
test.describe.serial("技能范围选择器菜单：挂到页面最外层且完整可见", () => {
  test.beforeAll(async () => {
    await ensureProvider();
  });

  /** 打开设置 → 技能页（中文界面，与上面用例同款前置） */
  async function openSkillsPage(page: import("@playwright/test").Page) {
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByText("技能", { exact: true }).click();
    await expect(page.getByTestId("skill-scope-select")).toBeVisible();
  }

  /** 技能页滚动容器（SkillSection 根 div，无 testid）：离触发按钮最近的可滚动祖先的溢出量 */
  async function scrollHostOverflow(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const btn = document.querySelector('[data-testid="skill-scope-select"]');
      if (!btn) return null;
      let el: HTMLElement | null = btn.parentElement;
      while (el) {
        const cs = getComputedStyle(el);
        if (
          !["visible", "clip"].includes(cs.overflowX) ||
          !["visible", "clip"].includes(cs.overflowY)
        )
          break;
        el = el.parentElement;
      }
      if (!el) return null;
      return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
    });
  }

  test("菜单完整落在视口内、贴按钮下方、父节点是 body（不撑出横向滚动条）", async ({ page }) => {
    await openSkillsPage(page);
    const scope = page.getByTestId("skill-scope-select");
    const buttonBox = (await scope.boundingBox())!;
    // 打开前：技能页滚动容器无横向溢出（对照面）
    expect((await scrollHostOverflow(page))!.x).toBeLessThanOrEqual(1);

    await scope.click();
    const menu = page.getByTestId("skill-scope-menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    // ① 完整落在视口内
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height + 1);
    // ② 贴按钮下方（视口空间足够，不翻转）
    expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 2);
    // ③ 菜单在最上层：中心点命中菜单自身（未被设置弹窗 / 遮罩遮挡）
    expect(
      await menu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      }),
    ).toBe(true);
    // ④ 打开后技能页滚动容器与设置弹窗内容区都不被撑出横向滚动条
    expect((await scrollHostOverflow(page))!.x).toBeLessThanOrEqual(1);
    expect(
      await page
        .getByTestId("settings-modal")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    // ⑤ 不是技能页滚动容器的子节点：portal 到 body 直下
    expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);

    // 选中默认工作区（SYSTEM_PROJECT_ID = __system__）后菜单移除（关闭行为不变）
    await page.getByTestId("skill-scope-option-project-__system__").click();
    await expect(menu).toHaveCount(0);
  });

  test("选择器只列默认工作区与各项目，不含「全部」「全局技能」", async ({ page }) => {
    await openSkillsPage(page);
    await page.getByTestId("skill-scope-select").click();
    const menu = page.getByTestId("skill-scope-menu");
    await expect(menu).toBeVisible();
    // 默认工作区在最前，菜单里不再有旧的「全部 / 🌐 全局技能」两项
    await expect(
      page.getByTestId("skill-scope-option-project-__system__"),
    ).toBeVisible();
    await expect(menu.getByText("全部", { exact: true })).toHaveCount(0);
    await expect(menu.getByText("🌐 全局技能")).toHaveCount(0);
  });

  test("技能目录默认折叠：折叠态只显示所选项目自己的技能目录路径", async ({ page }) => {
    await openSkillsPage(page);
    // 显式选中默认工作区（当前会话可能属于其它项目，避免依赖自动选中）
    await page.getByTestId("skill-scope-select").click();
    await page.getByTestId("skill-scope-option-project-__system__").click();
    // 折叠态：标题显示默认工作区的技能目录（<WA_PI_DIR>/workdir/.pi/skills）
    await expect(page.getByTestId("skill-dir-toggle")).toContainText(
      join(E2E_WA_PI_DIR, "workdir", ".pi", "skills"),
    );
    // 目录列表未渲染（默认折叠）
    await expect(page.locator('[data-testid^="skill-dir-open-"]')).toHaveCount(0);
  });

  test("短视口下菜单仍完整在视口内（向上翻转 / 夹取生效）", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 420 });
    await openSkillsPage(page);
    const scope = page.getByTestId("skill-scope-select");
    const buttonBox = (await scope.boundingBox())!;

    await scope.click();
    const menu = page.getByTestId("skill-scope-menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height + 1);
    // 不压按钮：要么在按钮下方，要么翻转到按钮上方（二者必居其一）
    const belowOk = menuBox.y >= buttonBox.y + buttonBox.height - 2;
    const aboveOk = menuBox.y + menuBox.height <= buttonBox.y + 2;
    expect(belowOk || aboveOk).toBe(true);
  });
});
