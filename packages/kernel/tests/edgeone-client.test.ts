import { test, expect, mock } from "bun:test";
import {
  detectBaseUrl,
  getOrCreateProject,
  getPresetDomain,
  encipherUrl,
  apiCall,
} from "../src/share/edgeone-client";

const fetchMock = mock(
  async (_url: string, _init?: any) => new Response("{}", { status: 200 }),
);
globalThis.fetch = fetchMock as any;

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
