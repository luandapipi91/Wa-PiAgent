import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { createShareRoutes } from "../src/routes/share";
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
      return Response.json({ Code: 0, Data: { Response: { Projects: [] } } });
    if (body.Action === "CreatePagesProject")
      return Response.json({ Code: 0, Data: { Response: { ProjectId: "p1" } } });
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
      return Response.json({ Code: 0, Data: { Response: { DeploymentId: "d1" } } });
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
      return Response.json({ Code: 0, Data: { Response: { Token: "et", Timestamp: 1 } } });
    return Response.json({ Code: 0, Data: { Response: {} } });
  });
}

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
