import { test, expect, describe } from "bun:test";
import {
  fetchGiteeLatestRelease,
  fetchGiteeAttachFiles,
  fetchText,
  findLatestYml,
  buildGiteeApi,
} from "./gitee-api.cjs";

const RELEASE_JSON = {
  id: 42,
  tag_name: "v0.2.0",
  name: "v0.2.0",
  body: "修复：文件预览持久化",
  html_url: "https://gitee.com/luandapipi/HiAgent/releases/v0.2.0",
};

const ATTACH_JSON = [
  { id: 1, name: "latest.yml", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml", size: 1024 },
  { id: 2, name: "WaPi-Setup-0.2.0.exe", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe", size: 134217728 },
  { id: 3, name: "WaPi-Setup-0.2.0.exe.blockmap", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe.blockmap", size: 8192 },
];

const LATEST_YML = `version: 0.2.0
files:
  - url: WaPi-Setup-0.2.0.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
    size: 134217728
path: WaPi-Setup-0.2.0.exe
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
releaseDate: '2026-08-02T00:00:00.000Z'
`;

function makeFetch(routes: Record<string, string>) {
  return async (url: string | URL) => {
    const key = String(url);
    const body = routes[key];
    if (body === undefined) throw new Error(`unexpected fetch: ${key}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
}

describe("fetchGiteeLatestRelease", () => {
  test("解析 releases/latest 响应", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON) }),
    });
    const release = await api.fetchLatestRelease();
    expect(release).toEqual({
      id: 42,
      tagName: "v0.2.0",
      body: "修复：文件预览持久化",
      htmlUrl: "https://gitee.com/luandapipi/HiAgent/releases/v0.2.0",
    });
  });

  test("404（无发行版）转为可读错误", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: async () => new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 }),
    });
    await expect(api.fetchLatestRelease()).rejects.toThrow(/暂无发行版|没有发布|404/);
  });
});

describe("fetchGiteeAttachFiles", () => {
  test("解析附件列表", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON) }),
    });
    const files = await api.fetchAttachFiles(42);
    expect(files).toHaveLength(3);
    expect(files[0]).toEqual({
      name: "latest.yml",
      browserDownloadUrl: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml",
      size: 1024,
    });
  });
});

describe("findLatestYml", () => {
  test("从附件列表找到 latest.yml", () => {
    const files = ATTACH_JSON.map(f => ({ name: f.name, browserDownloadUrl: f.browser_download_url, size: f.size }));
    const yml = findLatestYml(files);
    expect(yml?.name).toBe("latest.yml");
  });

  test("缺失时返回 null", () => {
    const files = ATTACH_JSON.slice(1).map(f => ({ name: f.name, browserDownloadUrl: f.browser_download_url, size: f.size }));
    expect(findLatestYml(files)).toBeNull();
  });
});

describe("fetchText + 解析", () => {
  test("下载 latest.yml 文本", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML }),
    });
    const text = await fetchText(api, "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml");
    expect(text).toContain("version: 0.2.0");
  });
});
