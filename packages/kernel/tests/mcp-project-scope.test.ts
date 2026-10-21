/**
 * 项目级 MCP 作用域开关端点（POST / GET /api/mcp/project-scope）
 *
 * 关键行为（规格 F11/F12/F13）：
 *   1. 开启 → <WA_PI_DIR>/trust.json 里以 **realpath(project.cwd) 原样** 为键写 true
 *      （pi 只在项目受信时才读 <cwd>/.pi/mcp.json，键写错即静默失效），
 *      并顺带把旧 .mcp.json 迁移到 <cwd>/.pi/mcp.json；
 *   2. 关闭 → 同一个键写 false，**不删键**（删键会退回上层继承，可能意外继承父目录的受信决定）；
 *   3. GET 回读真值：显式设置过 → true/false；自己和祖先都没条目 → `null`（前端以
 *      `data-unset="true"` 标记未设置，界面上不显示文案）。前端不能靠 pi 的 note 反推：项目还没有 .pi/mcp.json 时
 *      会把「未设置」显示成「已开」，而受信是安全决定；
 *   4. projectId 缺失 / enabled 非布尔 → 400；项目不存在 → 404。
 *
 * 隔离：WA_PI_DIR 在 beforeAll 指向临时目录，绝不触碰真实 ~/.pi/agent/trust.json。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpRouter } from "../src/http-router";
import { createMcpRoutes } from "../src/routes/mcp";
import { trustKeyFor } from "../src/mcp-trust";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

const ORIG_WA_PI_DIR = process.env.WA_PI_DIR;

let root: string;
/** 受信决定落盘处：默认 <WA_PI_DIR>/trust.json */
let trustFile: string;
/** 项目工作目录（每个用例一个干净的） */
let cwd: string;
let router: HttpRouter;

const PROJECT_ID = "proj-1";

function setupRouter(projectCwd: string | null, projectId = PROJECT_ID) {
  const router = new HttpRouter();
  // 本文件只测项目级开关端点，它不碰配置读写/状态读取/广播：给一组空桩即可
  // （任务 8 之后的注册器是工厂：MCP 域依赖从构造参数注入，不再走 RouteContext）。
  createMcpRoutes({
    mcpFile: {} as never,
    cwdForProject: async () => "",
    adminForCwd: (() => ({})) as never,
    invalidateCaches: () => {},
    broadcast: () => {},
    // 本文件只测项目级开关端点，它不碰登录/登出／凭据：给一组占位参数即可
    piSpawn: { runtime: "unused-runtime", cliPath: "unused-cli.js", agentDir: "" },
  })(
    router,
    (async () => Response.json({ ok: true })) as never,
    {
      projectStore: {
        load: async () => ({
          projects:
            projectCwd === null
              ? []
              : [{ id: projectId, name: "测试项目", cwd: projectCwd, createdAt: 0 }],
          sessions: [],
        }),
      } as never,
    },
  );
  return router;
}

function post(body: unknown): Promise<Response | null> {
  return router.handle(
    new Request("http://localhost/api/mcp/project-scope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(projectId?: string): Promise<Response | null> {
  const url = projectId
    ? `http://localhost/api/mcp/project-scope?projectId=${encodeURIComponent(projectId)}`
    : "http://localhost/api/mcp/project-scope";
  return router.handle(new Request(url));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wa-pi-mcp-scope-"));
  process.env.WA_PI_DIR = root;
  trustFile = join(root, "trust.json");
});

afterAll(async () => {
  process.env.WA_PI_DIR = ORIG_WA_PI_DIR ?? "";
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await rm(trustFile, { force: true }).catch(() => {});
  cwd = mkdtempSync(join(tmpdir(), "wa-pi-mcp-scope-proj-"));
  router = setupRouter(cwd);
});

async function readTrust(): Promise<Record<string, boolean>> {
  return JSON.parse(await readFile(trustFile, "utf8"));
}

describe("POST /api/mcp/project-scope", () => {
  test("开启项目作用域 → 以 realpath(cwd) 原样为键写 true，并触发旧配置迁移", async () => {
    // 旧文件存在 → 迁移应当被触发（migrateProjectMcpFile 只在有 .mcp.json 时才写盘）
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { legacy: { command: "node", directTools: ["t"] } } }),
      "utf8",
    );

    const res = await post({ projectId: PROJECT_ID, enabled: true });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, projectId: PROJECT_ID, enabled: true });

    // 键必须是 realpath 结果原样（大小写/分隔符/尾分隔符都错不得）
    expect(await readTrust()).toEqual({ [await trustKeyFor(cwd)]: true });

    // 迁移已跑：<cwd>/.pi/mcp.json 出现且字段已映射
    const migrated = JSON.parse(await readFile(join(cwd, ".pi", "mcp.json"), "utf8"));
    expect(migrated.mcpServers.legacy.exposure).toBe("codemode");
    expect(migrated.mcpServers.legacy.toolExposure).toEqual({ t: "direct" });
  });

  test("关闭项目作用域 → 同一个键写 false（不删键，避免退回上层继承）", async () => {
    await post({ projectId: PROJECT_ID, enabled: true });

    const res = await post({ projectId: PROJECT_ID, enabled: false });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, projectId: PROJECT_ID, enabled: false });

    const raw = await readTrust();
    const key = await trustKeyFor(cwd);
    expect(Object.hasOwn(raw, key)).toBe(true); // 键仍在
    expect(raw[key]).toBe(false);
  });

  test("关闭时不写盘 .pi/：没有旧配置的项目一路保持干净", async () => {
    await post({ projectId: PROJECT_ID, enabled: false });
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(await readTrust()).toEqual({ [await trustKeyFor(cwd)]: false });
  });

  test("缺少 projectId → 400 参数校验错误", async () => {
    const res = await post({ enabled: true });
    expect(res?.status).toBe(400);
    expect((await res?.json()).failure.code).toBe("common.missingParam");
  });

  test("enabled 非布尔 → 400（false 是合法值，不能用真值判断）", async () => {
    const res = await post({ projectId: PROJECT_ID, enabled: "true" });
    expect(res?.status).toBe(400);
    expect((await res?.json()).failure.code).toBe("common.missingParam");
    expect(existsSync(trustFile)).toBe(false); // 校验失败不得落盘
  });

  test("项目不存在 → 404 project.notFound", async () => {
    router = setupRouter(null);
    const res = await post({ projectId: "ghost", enabled: true });
    expect(res?.status).toBe(404);
    expect((await res?.json()).failure.code).toBe("project.notFound");
    expect(existsSync(trustFile)).toBe(false);
  });
});

// GET 是写侧开关的**真值回读**：前端开关的初值必须来自事实（trust.json），不能由 pi 的 note 反推。
// pi 只在「项目未受信 **且** 项目里已有 .pi/mcp.json」时才输出 note，靠 note 反推会把「没设过」
// 显示成「已开」——而受信是安全决定，UI 显示与事实不符不可接受（控制者裁决的缺口①）。
describe("GET /api/mcp/project-scope", () => {
  test("未显式设置 → enabled: null，且不凭空创建 trust.json", async () => {
    const res = await get(PROJECT_ID);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ enabled: null });
    expect(existsSync(trustFile)).toBe(false);
  });

  test("开启后回读 true、关闭后回读 false（与写侧同一份 trust.json）", async () => {
    await post({ projectId: PROJECT_ID, enabled: true });
    expect(await (await get(PROJECT_ID))?.json()).toEqual({ enabled: true });

    await post({ projectId: PROJECT_ID, enabled: false });
    expect(await (await get(PROJECT_ID))?.json()).toEqual({ enabled: false });
  });

  test("祖先受信时项目自身无条目 → 继承祖先的真值（与 pi 的查表语义一致）", async () => {
    // 只为父目录写一条受信决定；项目 cwd 自身没有条目
    const parentKey = await trustKeyFor(dirname(cwd));
    await writeFile(trustFile, JSON.stringify({ [parentKey]: true }), "utf8");

    const res = await get(PROJECT_ID);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ enabled: true });
  });

  test("缺少 projectId → 400 参数校验错误", async () => {
    const res = await get();
    expect(res?.status).toBe(400);
    expect((await res?.json()).failure.code).toBe("common.missingParam");
  });

  test("项目不存在 → 404 project.notFound", async () => {
    router = setupRouter(null);
    const res = await get("ghost");
    expect(res?.status).toBe(404);
    expect((await res?.json()).failure.code).toBe("project.notFound");
  });
});

// 默认工作区的 cwd 是 <WA_PI_DIR>/workdir，且查表做祖先继承：一旦写 true 会连同该目录下
// 每个会话的 <createdAt>/ 子目录、以及将来所有落在 workdir 下的工作目录一并受信。与 git 域
// 对 __system__ 显式 400（「无工作区语义」）同一策略。
describe("POST /api/mcp/project-scope（默认工作区）", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = join(root, "workdir");
    await mkdir(workdir, { recursive: true });
    router = setupRouter(workdir, SYSTEM_PROJECT_ID);
  });

  test("开启 → 400，且不落盘 trust.json、不触发迁移", async () => {
    // 放一个旧配置：若误触迁移就会出现在 <workdir>/.pi/mcp.json
    await writeFile(
      join(workdir, ".mcp.json"),
      JSON.stringify({ mcpServers: { legacy: { command: "node" } } }),
      "utf8",
    );

    const res = await post({ projectId: SYSTEM_PROJECT_ID, enabled: true });

    expect(res?.status).toBe(400);
    expect((await res?.json()).failure.code).toBe("mcp.systemProject");
    expect(existsSync(trustFile)).toBe(false);
    expect(existsSync(join(workdir, ".pi"))).toBe(false);
  });

  test("关闭 → 400，且已有 trust.json 一个字节不改", async () => {
    const before = JSON.stringify({ [await trustKeyFor(workdir)]: true });
    await writeFile(trustFile, before, "utf8");

    const res = await post({ projectId: SYSTEM_PROJECT_ID, enabled: false });

    expect(res?.status).toBe(400);
    expect((await res?.json()).failure.code).toBe("mcp.systemProject");
    expect(await readFile(trustFile, "utf8")).toBe(before);
  });
});
