import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CF_API_BASE,
  deployToCloudflare,
  getOrCreateProject,
} from "../src/share/cloudflare-pages-client";

// 可配置的 fetch mock：按 URL 段返回预设 JSON
function installFetchMock() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const handler = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (u.includes("/upload-token")) return json({ result: { jwt: "JWT_TEST" }, success: true });
    if (u.includes("/pages/assets/check-missing")) {
      // 回显请求中的 hashes，模拟“全部缺失”，确保走通上传路径
      const body = JSON.parse(String(init?.body));
      return json(body.hashes as string[]);
    }
    if (u.includes("/pages/assets/upload")) return json({ success: true });
    // 轮询 GET .../deployments/{id}（含尾部 id，需先于创建分支命中）
    if (u.includes("/deployments/")) {
      return json({ result: { latest_stage: { name: "deploy", status: "success" } }, success: true });
    }
    if (u.includes("/deployments")) return json({ result: { id: "dep-1", url: "https://abc.wapi-shares.pages.dev", environment: "production" }, success: true });
    if (u.endsWith("/pages/projects/wapi-shares")) {
      return json({ result: { id: "proj-1" }, success: true });
    }
    throw new Error(`unhandled mock URL: ${u}`);
  };
  // @ts-ignore 覆盖全局 fetch
  globalThis.fetch = handler as typeof fetch;
  return calls;
}

beforeEach(() => { installFetchMock(); });
afterEach(() => { delete (globalThis as any).fetch; });

describe("getOrCreateProject", () => {
  test("项目不存在时创建（POST）", async () => {
    const calls = installFetchMock();
    // 先让 GET 404，再让 POST 成功
    let n = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      n++;
      const u = String(url);
      if (u.endsWith("/pages/projects/wapi-shares") && n === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
      }
      if (u.endsWith("/pages/projects") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { id: "proj-new" }, success: true }));
      }
      throw new Error(`unhandled: ${u} #${n}`);
    }) as typeof fetch;
    const proj = await getOrCreateProject("tk", "acc-1", "wapi-shares");
    expect(proj.id).toBe("proj-new");
  });
});

describe("deployToCloudflare", () => {
  test("完整流程：上传 → 部署 → 轮询 → 返回 pages.dev URL", async () => {
    const calls = installFetchMock();
    const result = await deployToCloudflare({
      token: "tk",
      accountId: "acc-1",
      files: { "index.html": new TextEncoder().encode("<h1>hi</h1>"), "demo/app.js": new TextEncoder().encode("console.log(1)") },
      pollIntervalMs: 1,
    });
    expect(result.url).toBe("https://wapi-shares.pages.dev");
    expect(result.deploymentId).toBe("dep-1");
    // 上传流程按顺序发生
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/upload-token"))).toBe(true);
    expect(urls.some((u) => u.includes("/pages/assets/check-missing"))).toBe(true);
    expect(urls.some((u) => u.includes("/pages/assets/upload"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/deployments") && !u.includes("/deployments/"))).toBe(true);
  });

  test("缺少 accountId 抛错", async () => {
    expect(
      deployToCloudflare({ token: "tk", accountId: "", files: {} }),
    ).rejects.toThrow("Account ID");
  });

  test("check-missing 返回 401 时抛出带状态/信息的错误", async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/upload-token")) return json({ result: { jwt: "JWT_TEST" }, success: true });
      if (u.includes("/pages/assets/check-missing")) {
        return json({ success: false, errors: [{ message: "Invalid access token" }] }, 401);
      }
      if (u.endsWith("/pages/projects/wapi-shares")) {
        return json({ result: { id: "proj-1" }, success: true });
      }
      throw new Error(`unhandled mock URL: ${u}`);
    }) as typeof fetch;

    await expect(
      deployToCloudflare({
        token: "tk",
        accountId: "acc-1",
        files: { "index.html": new TextEncoder().encode("<h1>hi</h1>") },
      }),
    ).rejects.toThrow("check-missing failed: HTTP 401");
  });

  test("upload 返回 success:false 时抛出带信息的错误", async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/upload-token")) return json({ result: { jwt: "JWT_TEST" }, success: true });
      if (u.includes("/pages/assets/check-missing")) {
        const body = JSON.parse(String(init?.body));
        return json(body.hashes as string[]);
      }
      if (u.includes("/pages/assets/upload")) {
        return json({ success: false, errors: [{ message: "bucket quota exceeded" }] });
      }
      if (u.endsWith("/pages/projects/wapi-shares")) {
        return json({ result: { id: "proj-1" }, success: true });
      }
      throw new Error(`unhandled mock URL: ${u}`);
    }) as typeof fetch;

    await expect(
      deployToCloudflare({
        token: "tk",
        accountId: "acc-1",
        files: { "index.html": new TextEncoder().encode("<h1>hi</h1>") },
      }),
    ).rejects.toThrow("upload failed: HTTP 200");
  });
});
