import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { createShareRoutes, commonRoot } from "../src/routes/share";
import { MAX_FILE_BYTES } from "../src/share/workspace";
import { HttpRouter } from "../src/http-router";

let dir: string;
let workspaceDir: string;
let putObject: any;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "share-routes-"));
  workspaceDir = join(dir, "share-workspace");
  mkdirSync(join(dir, "prod"), { recursive: true });
  writeFileSync(join(dir, "prod", "index.html"), "<h1>x</h1>");
  putObject = mock((_opts: any, cb: any) => cb(null));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

/** 按 Action 模拟 EdgeOne API（同 edgeone-client.test.ts 的 mockEdgeOne 模式） */
function mockEdgeOne(presetDomain = "wapi-abc.edgeone.run") {
  globalThis.fetch = (async (_url: any, init: any) => {
    const action = JSON.parse(init.body).Action as string;
    const respond = (data: unknown) =>
      new Response(JSON.stringify({ Code: 0, Data: { Response: data } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    switch (action) {
      case "DescribePagesProjects":
        return respond({
          Projects: [{ ProjectId: "prj-1", PresetDomain: presetDomain }],
        });
      case "DescribePagesCosTempToken":
        return respond({
          Credentials: { TmpSecretId: "sid", TmpSecretKey: "skey", Token: "tk" },
          Bucket: "bkt",
          Region: "ap-gz",
          TargetPath: "tmp/xyz",
        });
      case "CreatePagesDeployment":
        return respond({ DeploymentId: "dep-1" });
      case "DescribePagesDeployments":
        return respond({
          Deployments: [{ DeploymentId: "dep-1", Status: "Success" }],
        });
      case "DescribePagesEncipherToken":
        return respond({ Token: "ET", Timestamp: 111 });
      default:
        return new Response(JSON.stringify({ Code: -1, Message: action }), {
          status: 200,
        });
    }
  }) as any;
}

/** 建路由：tmpdir 隔离 workspaceDir 与 settingsFile（settings 不存在 → 走 cfg.token） */
function setup(token = "tk_test") {
  const router = new HttpRouter();
  createShareRoutes(
    router,
    {
      token,
      channel: "edgeone",
      cosFactory: () => ({ putObject }) as any,
      settingsFile: join(dir, "settings.json"),
      pollIntervalMs: 1,
    },
    workspaceDir,
  );
  return router;
}

function post(router: HttpRouter, path: string, body: unknown) {
  return router.handle(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** 上传 prod/index.html 并断言成功，返回响应 JSON */
async function uploadOne(router: HttpRouter) {
  const res = await post(router, "/api/share/upload", {
    paths: [join(dir, "prod", "index.html")],
  });
  expect(res!.status).toBe(200);
  return res!.json();
}

test("commonRoot：多选路径取公共父目录；跨盘输入正常终止不陷入死循环", () => {
  expect(commonRoot(["/a/b/c.txt", "/a/b/d.txt"])).toBe("/a/b");
  expect(commonRoot(["/a/b/c.txt", "/a/e.txt"])).toBe("/a");
  // Windows 跨盘（C: vs D:）：盘符根处 dirname 恒等，护栏必须截断而非死循环。
  const cross = commonRoot(["C:\\proj\\a.txt", "D:\\proj\\b.txt"]);
  if (process.platform === "win32") expect(cross).toBe("C:\\");
  else expect(cross).toBe(".");
});

test("1. upload 单文件 → 200，url 指向 <id>/<file>，list 出现条目且 pending=0", async () => {
  mockEdgeOne();
  const router = setup();
  const data = await uploadOne(router);
  // url 形如 https://<domain>/<id>/<file>?eo_token=..
  expect(data.url).toMatch(
    /^https:\/\/wapi-abc\.edgeone\.run\/[0-9a-f]{12}\/index\.html\?eo_token=ET/,
  );
  expect(data.projectName).toBe("wapi");
  expect(data.channel).toBe("edgeone");
  expect(typeof data.id).toBe("string");
  expect(typeof data.expiresAt).toBe("number");
  expect(putObject).toHaveBeenCalled();

  const list = await (await router.handle(new Request("http://x/api/share/list")))!.json();
  expect(list.items).toHaveLength(1);
  expect(list.items[0].id).toBe(data.id);
  expect(list.items[0].name).toBe("index.html");
  // upload 已立即部署 → 无未部署变更
  expect(list.pending).toBe(0);
  expect(list.totalSize).toBeGreaterThan(0);
  expect(list.totalLimit).toBeGreaterThan(list.totalSize);
}, 15000);

test("2. upload 未配 token → 400", async () => {
  mockEdgeOne();
  const router = setup(""); // cfg.token 空 + settings 文件不存在 → 无 token
  const res = await post(router, "/api/share/upload", {
    paths: [join(dir, "prod", "index.html")],
  });
  expect(res!.status).toBe(400);
});

test("3. upload paths 为空 → 400", async () => {
  const router = setup();
  const res = await post(router, "/api/share/upload", { paths: [] });
  expect(res!.status).toBe(400);
});

test("4. upload 文件超 25MB → 413", async () => {
  mockEdgeOne();
  const big = join(dir, "prod", "big.bin");
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 1));
  const router = setup();
  const res = await post(router, "/api/share/upload", { paths: [big] });
  expect(res!.status).toBe(413);
  const data = await res!.json();
  expect(data.error).toContain("25MB");
}, 15000);

test("5. delete → list 少一条且 pending+1；clear → list 空", async () => {
  mockEdgeOne();
  const router = setup();
  const up = await uploadOne(router);

  const del = await post(router, "/api/share/delete", { id: up.id });
  expect(await del!.json()).toEqual({ ok: true });
  const list1 = await (await router.handle(new Request("http://x/api/share/list")))!.json();
  expect(list1.items).toHaveLength(0);
  // delete 仅改本地 → 与上次部署快照产生 1 项未部署变更
  expect(list1.pending).toBe(1);

  await uploadOne(router);
  const clr = await post(router, "/api/share/clear", {});
  expect(await clr!.json()).toEqual({ ok: true });
  const list2 = await (await router.handle(new Request("http://x/api/share/list")))!.json();
  expect(list2.items).toHaveLength(0);
}, 15000);

test("6. deploy → pending 归零", async () => {
  mockEdgeOne();
  const router = setup();
  const up = await uploadOne(router);
  // 先制造未部署变更（本地删除）
  await post(router, "/api/share/delete", { id: up.id });
  const before = await (await router.handle(new Request("http://x/api/share/list")))!.json();
  expect(before.pending).toBe(1);

  const res = await post(router, "/api/share/deploy", {});
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(data.ok).toBe(true);
  expect(typeof data.expiresAt).toBe("number");
  const after = await (await router.handle(new Request("http://x/api/share/list")))!.json();
  expect(after.pending).toBe(0);
}, 15000);

test("6b. deploy 未配 token → 400", async () => {
  const router = setup("");
  const res = await post(router, "/api/share/deploy", {});
  expect(res!.status).toBe(400);
});

test("7. refresh-link：存在 id 返回新 url；不存在 → 404", async () => {
  mockEdgeOne();
  const router = setup();
  const up = await uploadOne(router);

  const res = await post(router, "/api/share/refresh-link", { id: up.id });
  const data = await res!.json();
  expect(res!.status).toBe(200);
  expect(data.url).toContain(`/${up.id}/index.html`);
  expect(data.url).toContain("eo_token=ET");
  expect(typeof data.expiresAt).toBe("number");

  const missing = await post(router, "/api/share/refresh-link", { id: "nope" });
  expect(missing!.status).toBe(404);
}, 15000);
