import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { createShareRoutes, commonRoot } from "../src/routes/share";
import { HttpRouter } from "../src/http-router";

let dir: string;
let historyFile: string;
let putObject: any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "share-routes-"));
  historyFile = join(dir, "share-history.json");
  mkdirSync(join(dir, "prod"), { recursive: true });
  writeFileSync(join(dir, "prod", "index.html"), "<h1>x</h1>");
  putObject = mock((_opts: any, cb: any) => cb(null));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// mock 全局 fetch 驱动 EdgeOne API 各 Action
function edgeOneFetch() {
  return mock(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.Action === "DescribePagesProjects")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            // 项目须带 PresetDomain：getPresetDomain 拿不到会抛错（不再降级用 Name）
            Projects: [
              {
                ProjectId: "p1",
                Name: "share-x",
                PresetDomain: "share-x.edgeone.cool",
              },
            ],
          },
        },
      });
    if (body.Action === "CreatePagesProject")
      return Response.json({
        Code: 0,
        Data: { Response: { ProjectId: "p1" } },
      });
    if (body.Action === "DescribePagesCosTempToken")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            Bucket: "b",
            Region: "ap-guangzhou",
            TargetPath: "t",
            Credentials: {
              TmpSecretId: "i",
              TmpSecretKey: "k",
              Token: "tok",
            },
          },
        },
      });
    if (body.Action === "CreatePagesDeployment")
      return Response.json({
        Code: 0,
        Data: { Response: { DeploymentId: "d1" } },
      });
    if (body.Action === "DescribePagesDeployments")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            Deployments: [
              { DeploymentId: "d1", Status: "Success", PreviewUrl: "" },
            ],
          },
        },
      });
    if (body.Action === "DescribePagesEncipherToken")
      return Response.json({
        Code: 0,
        Data: { Response: { Token: "et", Timestamp: 1 } },
      });
    return Response.json({ Code: 0, Data: { Response: {} } });
  });
}

test("commonRoot：多选路径取公共父目录；跨盘输入正常终止不陷入死循环", () => {
  expect(commonRoot(["/a/b/c.txt", "/a/b/d.txt"])).toBe("/a/b");
  expect(commonRoot(["/a/b/c.txt", "/a/e.txt"])).toBe("/a");
  // Windows 跨盘（C: vs D:）：盘符根处 dirname 恒等，护栏必须截断而非死循环。
  // Windows 上无公共根 → 兜底保留首个路径的父目录；非 Windows 平台反斜杠不是
  // 分隔符，dirname 返回 "."（相对路径），同样验证能正常终止。
  const cross = commonRoot(["C:\\proj\\a.txt", "D:\\proj\\b.txt"]);
  if (process.platform === "win32") expect(cross).toBe("C:\\proj");
  else expect(cross).toBe(".");
});

test("POST /api/share/upload 成功返回 { url, expiresAt, projectName, channel }", async () => {
  const fetchMock = edgeOneFetch();
  globalThis.fetch = fetchMock as any;
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token: "tk_test",
      channel: "edgeone",
      cosFactory: () => ({ putObject }) as any,
      // 隔离测试 settings：不存在 → token 为空 → 走 cfg.token
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    historyFile,
    join(dir, "prod"),
  );
  const res = await router.handle(
    new Request("http://x/api/share/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [join(dir, "prod", "index.html")] }),
    }),
  );
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(data.url).toContain("eo_token=et");
  expect(data.projectName).toMatch(/^share-[0-9a-f]{12}$/);
  expect(data.channel).toBe("edgeone");
  expect(typeof data.expiresAt).toBe("number");
  // COS 上传经 cosFactory 注入的 fake 被调用（单文件直传 putObject）
  expect(putObject).toHaveBeenCalled();
  // 记录已写入 history
  const shares = JSON.parse(await Bun.file(historyFile).text()).shares;
  expect(shares).toHaveLength(1);
  expect(shares[0].projectName).toBe(data.projectName);
}, 15000);

test("paths 为空返回 400", async () => {
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token: "tk_test",
      channel: "edgeone",
      cosFactory: () => ({ putObject }) as any,
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    historyFile,
    join(dir, "prod"),
  );
  const res = await router.handle(
    new Request("http://x/api/share/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [] }),
    }),
  );
  expect(res!.status).toBe(400);
});

test("token 为空返回 400", async () => {
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token: "",
      channel: "edgeone",
      cosFactory: () => ({ putObject }) as any,
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    historyFile,
    join(dir, "prod"),
  );
  const res = await router.handle(
    new Request("http://x/api/share/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [join(dir, "prod", "index.html")] }),
    }),
  );
  expect(res!.status).toBe(400);
});

test("GET /api/share/list 返回 shares 列表", async () => {
  const router = new HttpRouter();
  createShareRoutes(
    router,
    { token: "", channel: "edgeone", settingsFile: join(dir, "settings.json") },
    historyFile,
    join(dir, "prod"),
  );
  const res = await router.handle(new Request("http://x/api/share/list"));
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(Array.isArray(data.shares)).toBe(true);
});

test("POST /api/share/delete 删除记录并返回 { ok: true }", async () => {
  // 预置一条记录到 history
  writeFileSync(
    historyFile,
    JSON.stringify({
      shares: [
        {
          id: "rec-1",
          url: "https://x",
          projectName: "share-abc",
          channel: "edgeone",
          createdAt: 1,
          expiresAt: 2,
          paths: ["/a"],
        },
      ],
    }),
  );
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token: "",
      channel: "edgeone",
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    historyFile,
    join(dir, "prod"),
  );
  const res = await router.handle(
    new Request("http://x/api/share/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "rec-1" }),
    }),
  );
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(data).toEqual({ ok: true });
  const shares = JSON.parse(await Bun.file(historyFile).text()).shares;
  expect(shares).toHaveLength(0);
});

test("POST /api/share/upload 多选：putObject 传 bundle.zip，部署 DistType=Zip", async () => {
  let deploymentBody: any;
  globalThis.fetch = mock(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.Action === "DescribePagesProjects")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            // 项目须带 PresetDomain：getPresetDomain 拿不到会抛错（不再降级用 Name）
            Projects: [
              {
                ProjectId: "p1",
                Name: "share-x",
                PresetDomain: "share-x.edgeone.cool",
              },
            ],
          },
        },
      });
    if (body.Action === "CreatePagesProject")
      return Response.json({
        Code: 0,
        Data: { Response: { ProjectId: "p1" } },
      });
    if (body.Action === "DescribePagesCosTempToken")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            Bucket: "b",
            Region: "ap-guangzhou",
            TargetPath: "t",
            Credentials: {
              TmpSecretId: "i",
              TmpSecretKey: "k",
              Token: "tok",
            },
          },
        },
      });
    if (body.Action === "CreatePagesDeployment") {
      deploymentBody = body;
      return Response.json({
        Code: 0,
        Data: { Response: { DeploymentId: "d1" } },
      });
    }
    if (body.Action === "DescribePagesDeployments")
      return Response.json({
        Code: 0,
        Data: {
          Response: {
            Deployments: [
              { DeploymentId: "d1", Status: "Success", PreviewUrl: "" },
            ],
          },
        },
      });
    if (body.Action === "DescribePagesEncipherToken")
      return Response.json({
        Code: 0,
        Data: { Response: { Token: "et", Timestamp: 1 } },
      });
    return Response.json({ Code: 0, Data: { Response: {} } });
  }) as any;
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token: "tk_test",
      channel: "edgeone",
      cosFactory: () => ({ putObject }) as any,
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    historyFile,
    join(dir, "prod"),
  );
  writeFileSync(join(dir, "prod", "a.html"), "<h1>a</h1>");
  writeFileSync(join(dir, "prod", "b.css"), "body{}");
  const res = await router.handle(
    new Request("http://x/api/share/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: [join(dir, "prod", "a.html"), join(dir, "prod", "b.css")],
      }),
    }),
  );
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(typeof data.url).toBe("string");
  const putArgs = putObject.mock.calls.map((c: any) => c[0] as any);
  expect(putArgs.some((a: any) => a.Key.endsWith("/bundle.zip"))).toBe(true);
  expect(deploymentBody.DistType).toBe("Zip");
}, 15000);
