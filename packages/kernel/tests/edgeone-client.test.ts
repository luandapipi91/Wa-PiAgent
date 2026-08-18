import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  detectBaseUrl,
  getOrCreateProject,
  getPresetDomain,
  encipherUrl,
  apiCall,
  deployWorkspace,
  itemShareUrl,
  normalizeDomain,
  SHARE_PROJECT_NAME,
} from "../src/share/edgeone-client";

const fetchMock = mock(
  async (_url: string, _init?: any) => new Response("{}", { status: 200 }),
);
// 真实 fetch 必须在任何劫持之前捕获；劫持/恢复按用例维度进行（beforeEach/afterEach），
// 避免模块加载即劫持全局 fetch，污染非 isolate 模式下同进程的其他测试文件。
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = fetchMock as any;
});

const JSON_RES = (data: any) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("detectBaseUrl 优先可用端点（china 成功则用 china）", async () => {
  fetchMock.mockImplementation(async (url: string, _init?: any) => {
    if (String(url).includes("cloud.tencent.com"))
      return JSON_RES({ Code: 0, Data: { Response: {} } });
    return new Response("{}", { status: 500 });
  });
  const base = await detectBaseUrl("tk");
  expect(base).toContain("cloud.tencent.com");
});

test("getOrCreateProject：不存在则创建，返回 ProjectId", async () => {
  const calls: any[] = [];
  fetchMock.mockImplementation(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body.Action);
    if (body.Action === "DescribePagesProjects")
      return JSON_RES({ Code: 0, Data: { Response: { Projects: [] } } });
    if (body.Action === "CreatePagesProject")
      return JSON_RES({ Code: 0, Data: { Response: { ProjectId: "p1" } } });
    return JSON_RES({ Code: 0, Data: { Response: {} } });
  });
  const pid = await getOrCreateProject("https://api", "tk", "share-abc");
  expect(pid).toBe("p1");
  expect(calls).toContain("CreatePagesProject");
});

test("encipherUrl：用项目域名 + encipher token 拼 URL", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.Action === "DescribePagesEncipherToken")
      return JSON_RES({
        Code: 0,
        Data: { Response: { Token: "tok", Timestamp: 123 } },
      });
    return JSON_RES({ Code: 0, Data: { Response: {} } });
  });
  const url = await encipherUrl(
    "https://api",
    "tk",
    "wa-pi-share-abc.edgeone.cool",
  );
  expect(url).toBe(
    "https://wa-pi-share-abc.edgeone.cool?eo_token=tok&eo_time=123",
  );
});

test("apiCall：非 2xx 状态码抛 HTTP 错误", async () => {
  fetchMock.mockImplementation(async (_url: string, _init?: any) => {
    return new Response("oops", { status: 500 });
  });
  await expect(apiCall("https://api", "tk", "SomeAction")).rejects.toThrow(
    "[SomeAction] HTTP 500",
  );
});

test("apiCall：业务 Code!==0 抛业务错误", async () => {
  fetchMock.mockImplementation(async (_url: string, _init?: any) => {
    return JSON_RES({ Code: 4000, Message: "bad request" });
  });
  await expect(apiCall("https://api", "tk", "SomeAction")).rejects.toThrow(
    "[SomeAction] Code 4000: bad request",
  );
});

test("getOrCreateProject：已存在则直接返回 ProjectId", async () => {
  fetchMock.mockImplementation(async (_url: string, _init?: any) => {
    return JSON_RES({
      Code: 0,
      Data: { Response: { Projects: [{ ProjectId: "p-exist" }] } },
    });
  });
  const pid = await getOrCreateProject("https://api", "tk", "share-abc");
  expect(pid).toBe("p-exist");
});

test("getOrCreateProject：创建未回带 ProjectId 时重查兜底", async () => {
  let describeCalls = 0;
  fetchMock.mockImplementation(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.Action === "CreatePagesProject")
      return JSON_RES({ Code: 0, Data: { Response: {} } });
    describeCalls += 1;
    // 首次查询为空 → 触发创建；重查（第二次 Describe）返回项目
    return describeCalls === 1
      ? JSON_RES({ Code: 0, Data: { Response: { Projects: [] } } })
      : JSON_RES({
          Code: 0,
          Data: { Response: { Projects: [{ ProjectId: "p-requery" }] } },
        });
  });
  const pid = await getOrCreateProject("https://api", "tk", "share-abc");
  expect(pid).toBe("p-requery");
  expect(describeCalls).toBe(2);
});

test("detectBaseUrl：china 失败则回退 global 成功", async () => {
  fetchMock.mockImplementation(async (url: string, _init?: any) => {
    if (String(url).includes("cloud.tencent.com"))
      return new Response("{}", { status: 500 });
    if (String(url).includes("edgeone.ai"))
      return JSON_RES({ Code: 0, Data: { Response: {} } });
    return new Response("{}", { status: 500 });
  });
  const base = await detectBaseUrl("tk");
  expect(base).toContain("edgeone.ai");
});

test("detectBaseUrl：两端点全失败则抛错", async () => {
  fetchMock.mockImplementation(async (_url: string, _init?: any) => {
    return new Response("{}", { status: 500 });
  });
  await expect(detectBaseUrl("tk")).rejects.toThrow("EdgeOne API 端点均不可用");
});

test("getPresetDomain：返回项目 PresetDomain", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.Action).toBe("DescribePagesProjects");
    expect(body.Filters[0].Name).toBe("ProjectId");
    expect(body.Filters[0].Values).toEqual(["p1"]);
    return JSON_RES({
      Code: 0,
      Data: {
        Response: {
          Projects: [{ ProjectId: "p1", PresetDomain: "dom.example" }],
        },
      },
    });
  });
  const domain = await getPresetDomain("https://api", "tk", "p1");
  expect(domain).toBe("dom.example");
});

test("getPresetDomain：PresetDomain 为空时抛错，不静默降级用 Name（Name 不是域名）", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.Action).toBe("DescribePagesProjects");
    return JSON_RES({
      Code: 0,
      Data: {
        Response: {
          // 仅有 Name（项目名），没有 PresetDomain
          Projects: [{ ProjectId: "p1", Name: "share-abc" }],
        },
      },
    });
  });
  await expect(getPresetDomain("https://api", "tk", "p1")).rejects.toThrow(
    "无法获取项目域名",
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 按 Action 模拟 EdgeOne API：项目不存在→创建；COS 凭证→固定值；部署→Success；域名→预设域名 */
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
        return respond({ Projects: [{ ProjectId: "prj-1", PresetDomain: presetDomain }] });
      case "DescribePagesCosTempToken":
        return respond({
          Credentials: { TmpSecretId: "sid", TmpSecretKey: "skey", Token: "tk" },
          Bucket: "bkt", Region: "ap-gz", TargetPath: "tmp/xyz",
        });
      case "CreatePagesDeployment":
        return respond({ DeploymentId: "dep-1" });
      case "DescribePagesDeployments":
        return respond({ Deployments: [{ DeploymentId: "dep-1", Status: "Success" }] });
      case "DescribePagesEncipherToken":
        return respond({ Token: "ET", Timestamp: 111 });
      default:
        return new Response(JSON.stringify({ Code: -1, Message: action }), { status: 200 });
    }
  }) as any;
}

const fakeCos = () =>
  ({
    putObject: (_o: any, cb: (e: any) => void) => cb(null),
    uploadFiles: (_o: any, cb: (e: any) => void) => cb(null),
  }) as any;

test("deployWorkspace：固定项目 wapi + 预设域名 + 3h 过期", async () => {
  mockEdgeOne();
  const r = await deployWorkspace({
    token: "t",
    zip: new Uint8Array([1, 2]),
    cosFactory: fakeCos,
    pollIntervalMs: 1,
  });
  expect(r.projectName).toBe(SHARE_PROJECT_NAME);
  expect(r.domain).toBe("wapi-abc.edgeone.run");
  expect(r.rootUrl).toBe("https://wapi-abc.edgeone.run?eo_token=ET&eo_time=111");
  expect(r.expiresAt).toBeGreaterThan(Date.now());
});

test("deployWorkspace：自定义域名优先于预设域名", async () => {
  mockEdgeOne();
  const r = await deployWorkspace({
    token: "t",
    zip: new Uint8Array([1]),
    customDomain: "https://share.example.com/",
    cosFactory: fakeCos,
    pollIntervalMs: 1,
  });
  expect(r.domain).toBe("share.example.com");
  expect(r.rootUrl).toBe("https://share.example.com?eo_token=ET&eo_time=111");
});

test("normalizeDomain：去协议与尾斜杠", () => {
  expect(normalizeDomain("https://share.example.com/")).toBe("share.example.com");
  expect(normalizeDomain("  http://a.b/c/ ")).toBe("a.b/c");
  expect(normalizeDomain(undefined)).toBe("");
  expect(normalizeDomain("")).toBe("");
});

test("itemShareUrl：单文件带文件名，多文件带目录尾斜杠（子路径用分享名，中文 URL 编码）", () => {
  const root = "https://d.example.com?eo_token=T&eo_time=1";
  // 中文名在 URL 路径里被 percent-encode（正常 URL 行为）
  expect(itemShareUrl(root, { id: "abc", name: "报告", files: ["a.html"] })).toBe(
    "https://d.example.com/%E6%8A%A5%E5%91%8A/a.html?eo_token=T&eo_time=1",
  );
  expect(
    itemShareUrl(root, {
      id: "abc",
      name: "报告",
      files: ["index.html", "x.js"],
    }),
  ).toBe("https://d.example.com/%E6%8A%A5%E5%91%8A/?eo_token=T&eo_time=1");
});

test("deployWorkspace：部署失败终态抛错", async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    const action = JSON.parse(init.body).Action as string;
    const respond = (data: unknown) =>
      new Response(JSON.stringify({ Code: 0, Data: { Response: data } }), { status: 200 });
    if (action === "DescribePagesProjects")
      return respond({ Projects: [{ ProjectId: "p", PresetDomain: "d.edgeone.run" }] });
    if (action === "DescribePagesCosTempToken")
      return respond({ Credentials: { TmpSecretId: "a", TmpSecretKey: "b", Token: "c" }, Bucket: "b", Region: "r", TargetPath: "t" });
    if (action === "CreatePagesDeployment") return respond({ DeploymentId: "dep-1" });
    if (action === "DescribePagesDeployments")
      return respond({ Deployments: [{ DeploymentId: "dep-1", Status: "Failed" }] });
    return respond({});
  }) as any;
  await expect(
    deployWorkspace({ token: "t", zip: new Uint8Array([1]), cosFactory: fakeCos, pollIntervalMs: 1 }),
  ).rejects.toThrow("部署失败");
});

test("apiCall：顶层 Code=0 但 Data.Response.Error 嵌套错误时抛错（回归：项目名过短静默失败→部署超时）", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        Code: 0,
        Data: {
          Response: {
            Error: { Code: "InvalidParameter.Security", Message: "Name ranges from 5 to 63 length" },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
  const { apiCall } = await import("../src/share/edgeone-client");
  await expect(apiCall("https://x", "t", "CreatePagesProject", {})).rejects.toThrow(
    "Name ranges from 5 to 63 length",
  );
});
