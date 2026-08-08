import { test, expect, describe } from "bun:test";
import { GiteeProvider } from "./gitee-provider.cjs";

const LATEST_YML = `version: 0.2.0
files:
  - url: WaPi-Setup-0.2.0.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
    size: 134217728
path: WaPi-Setup-0.2.0.exe
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
releaseDate: '2026-08-02T00:00:00.000Z'
`;

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
];

function makeFetch(routes: Record<string, string>) {
  return async (url: string | URL) => {
    const body = routes[String(url)];
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body, { status: 200 });
  };
}

function makeProvider(fetchImpl: any) {
  // executor 只用于 Provider 基类属性（isUseMultipleRangeRequest/fileExtraDownloadHeaders），
  // getLatestVersion 用注入的 fetch，不依赖 executor 发起真实请求。
  const executor = { request: async () => { throw new Error("executor 不应被调用"); } };
  const provider = new GiteeProvider({
    runtimeOptions: { isUseMultipleRangeRequest: true, platform: "win32", executor },
    baseUrl: "https://gitee.com/api/v5",
    owner: "luandapipi",
    repo: "HiAgent",
    fetchImpl,
  });
  return provider;
}

describe("GiteeProvider.getLatestVersion", () => {
  test("返回解析后的 UpdateInfo + releaseNotes", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    const info = await provider.getLatestVersion();
    expect(info.version).toBe("0.2.0");
    expect(info.releaseNotes).toBe("修复：文件预览持久化");
    expect(info.files).toHaveLength(1);
    expect(info.files[0].url).toBe("WaPi-Setup-0.2.0.exe");
  });

  test("附件缺 latest.yml 时报错", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify([]),
    });
    const provider = makeProvider(fetchImpl);
    await expect(provider.getLatestVersion()).rejects.toThrow(/latest\.yml/);
  });
});

describe("GiteeProvider.resolveFiles", () => {
  test("把文件名映射为 Gitee 下载 URL", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    await provider.getLatestVersion();
    const files = provider.resolveFiles({ files: [{ url: "WaPi-Setup-0.2.0.exe", sha512: "x", size: 1 }] });
    expect(files[0].url.href).toBe("https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe");
  });

  test("文件不在附件列表时报错", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    await provider.getLatestVersion();
    expect(() => provider.resolveFiles({ files: [{ url: "missing.exe", sha512: "x", size: 1 }] }))
      .toThrow(/missing\.exe/);
  });
});
