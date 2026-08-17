import { test, expect, mock } from "bun:test";
import {
  detectBaseUrl,
  getOrCreateProject,
  encipherUrl,
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

test("buildShareUrl：用项目域名 + encipher token 拼 URL", async () => {
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
  expect(url).toBe("https://wa-pi-share-abc.edgeone.cool?eo_token=tok&eo_time=123");
});
