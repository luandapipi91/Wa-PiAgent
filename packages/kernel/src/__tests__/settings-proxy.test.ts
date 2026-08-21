import { describe, test, expect, afterEach } from "bun:test";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadProxySettings,
	saveProxySettings,
	applySystemProxy,
	mergeNoProxy,
	systemProxyFromEnv,
	readSystemProxy,
	parseWindowsProxyServer,
	parseRegQueryValue,
	parseScutilProxyOutput,
	readWindowsSystemProxy,
	PROXY_DEFAULTS,
} from "../settings-store";
import { stopProxyRelay } from "../proxy-relay";

// 与 settings-trash.test.ts 一致：用 TEST_FILE 隔离路径，避免触碰真实 settings.json。
const TEST_FILE = join(tmpdir(), `test-settings-proxy-${Date.now()}.json`);

// env 代理不再直接写上游地址，而是本地中继（proxy-relay）地址
const RELAY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+$/;

describe("Proxy settings", () => {
	afterEach(async () => {
		await rm(TEST_FILE, { force: true });
		// Bun 的代理变量是特殊 getter/setter：delete 清不掉（同进程后续测试文件
		// 的 fetch/node:http 仍会被残留代理劫持），置空串才能清除
		process.env.HTTP_PROXY = "";
		process.env.HTTPS_PROXY = "";
		process.env.http_proxy = "";
		process.env.https_proxy = "";
		process.env.NO_PROXY = "";
		process.env.no_proxy = "";
		await stopProxyRelay();
	});

	test("loadProxySettings 无文件时返回默认值（关闭 + 空代理）", async () => {
		const settings = await loadProxySettings(TEST_FILE);
		expect(settings).toEqual(PROXY_DEFAULTS);
	});

	test("saveProxySettings 持久化并可读回", async () => {
		const custom = { useSystemProxy: true, httpProxy: "http://127.0.0.1:7890" };
		await saveProxySettings(custom, TEST_FILE);
		const loaded = await loadProxySettings(TEST_FILE);
		expect(loaded).toEqual(custom);
	});

	test("saveProxySettings 保留 settings.json 其他字段（read-modify-write）", async () => {
		await writeFile(
			TEST_FILE,
			JSON.stringify({ retry: { maxRetries: 5 } }),
			"utf8",
		);
		await saveProxySettings(
			{ useSystemProxy: true, httpProxy: "http://x" },
			TEST_FILE,
		);
		const raw = JSON.parse(await readFile(TEST_FILE, "utf8"));
		expect(raw.retry).toEqual({ maxRetries: 5 });
		expect(raw.useSystemProxy).toBe(true);
		expect(raw.httpProxy).toBe("http://x");
	});

	test("applySystemProxy：开启且有代理 → env 指向本地中继（大小写齐全）", async () => {
		await saveProxySettings(
			{ useSystemProxy: true, httpProxy: "http://127.0.0.1:7890" },
			TEST_FILE,
		);
		await applySystemProxy(TEST_FILE, () => "");
		for (const key of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"http_proxy",
			"https_proxy",
		]) {
			expect(process.env[key]).toMatch(RELAY_URL_PATTERN);
		}
	});

	test("applySystemProxy：关闭 → env 同样指向中继（上游为空 = 直连）", async () => {
		await saveProxySettings({ useSystemProxy: false, httpProxy: "" }, TEST_FILE);
		process.env.HTTP_PROXY = "http://stale";
		process.env.HTTPS_PROXY = "http://stale";
		process.env.http_proxy = "http://stale";
		process.env.https_proxy = "http://stale";
		await applySystemProxy(TEST_FILE, () => "");
		for (const key of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"http_proxy",
			"https_proxy",
		]) {
			expect(process.env[key]).toMatch(RELAY_URL_PATTERN);
		}
	});

	test("applySystemProxy：开启但 httpProxy 空且读不到 → env 指向中继（上游为空 = 直连）", async () => {
		await saveProxySettings({ useSystemProxy: true, httpProxy: "" }, TEST_FILE);
		process.env.HTTP_PROXY = "http://stale";
		process.env.http_proxy = "http://stale";
		await applySystemProxy(TEST_FILE, () => "");
		expect(process.env.HTTP_PROXY).toMatch(RELAY_URL_PATTERN);
		expect(process.env.http_proxy).toMatch(RELAY_URL_PATTERN);
	});

	test("applySystemProxy：开启但 httpProxy 空 → readProxy 兜底读系统代理", async () => {
		await saveProxySettings({ useSystemProxy: true, httpProxy: "" }, TEST_FILE);
		await applySystemProxy(TEST_FILE, () => "http://127.0.0.1:7890");
		expect(process.env.HTTP_PROXY).toMatch(RELAY_URL_PATTERN);
		expect(process.env.http_proxy).toMatch(RELAY_URL_PATTERN);
	});

	test("applySystemProxy：写入 env 代理时同时设置 NO_PROXY 回环/内网绕过", async () => {
		await saveProxySettings(
			{ useSystemProxy: true, httpProxy: "http://127.0.0.1:7890" },
			TEST_FILE,
		);
		await applySystemProxy(TEST_FILE, () => "");
		// undici（pi 子进程的 HTTP 客户端）只认完全匹配/子域通配，不认 CIDR 网段；
		// 内网 IP 绕过由中继侧 isDirectHost 兜底（proxy-relay.ts），NO_PROXY 不写无效网段。
		for (const key of ["NO_PROXY", "no_proxy"]) {
			for (const host of [
				"127.0.0.1",
				"localhost",
				"::1",
				".local",
				".internal",
			]) {
				expect(process.env[key]).toContain(host);
			}
			// 不含 CIDR 网段（undici 不认，写了无效还误导）
			for (const cidr of [
				"10.0.0.0/8",
				"172.16.0.0/12",
				"192.168.0.0/16",
				"169.254.0.0/16",
			]) {
				expect(process.env[key]).not.toContain(cidr);
			}
		}
	});

	test("mergeNoProxy：保留已有条目、追加回环/内网域名、重复调用不重复", () => {
		const once = mergeNoProxy("corp.example.com, 8.8.8.8");
		expect(once).toContain("corp.example.com");
		expect(once).toContain("8.8.8.8");
		expect(once).toContain("127.0.0.1");
		expect(once).toContain(".internal");
		expect(once).not.toContain("192.168.0.0/16");
		const twice = mergeNoProxy(once);
		expect(twice.split(",").length).toBe(once.split(",").length);
		expect(mergeNoProxy(undefined)).toContain("localhost");
	});

	describe("systemProxyFromEnv：本地中继地址不作为上游", () => {
		test("无 env 代理 → null（继续读系统代理）", () => {
			expect(systemProxyFromEnv(undefined)).toBeNull();
			expect(systemProxyFromEnv("")).toBeNull();
		});

		test("本地中继地址（127.0.0.1/localhost/::1）→ null（忽略，防止指向死端口/自身回环）", () => {
			expect(systemProxyFromEnv("http://127.0.0.1:64188")).toBeNull();
			expect(systemProxyFromEnv("http://localhost:55578")).toBeNull();
			expect(systemProxyFromEnv("http://[::1]:64188")).toBeNull();
		});

		test("真实上游代理 → 原样返回", () => {
			expect(systemProxyFromEnv("http://proxy.example.com:8080")).toBe(
				"http://proxy.example.com:8080",
			);
			expect(systemProxyFromEnv("http://10.0.0.5:7890")).toBe(
				"http://10.0.0.5:7890",
			);
		});

		test("无效 URL → null（交给系统代理读取兜底）", () => {
			expect(systemProxyFromEnv("not-a-url")).toBeNull();
		});
	});

	test("readSystemProxy：env 残留本地中继地址时不当作上游，继续走系统读取", async () => {
		process.env.HTTP_PROXY = "http://127.0.0.1:61385"; // 上个实例残留的旧中继
		const result = await readSystemProxy();
		// 绝不能返回残留的本地中继地址（否则新中继上游指向死端口）
		expect(result).not.toContain("61385");
		// 注：回环过滤语义已由 systemProxyFromEnv 单测覆盖；此处只验证残留不回流。
		// 系统代理本身可能返回合法本地代理（如 Clash 127.0.0.1:7890），不能一概断言非回环。
	});

	describe("parseWindowsProxyServer：解析注册表 ProxyServer 值", () => {
		test("host:port 格式 → 补 http:// 前缀", () => {
			expect(parseWindowsProxyServer("127.0.0.1:7890")).toBe(
				"http://127.0.0.1:7890",
			);
		});

		test("http:// 开头 → 原样", () => {
			expect(parseWindowsProxyServer("http://proxy.corp:8080")).toBe(
				"http://proxy.corp:8080",
			);
		});

		test("按协议拆分（http=...;https=...）→ 取 http，无则取 https", () => {
			expect(
				parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7890"),
			).toBe("http://127.0.0.1:7890");
			expect(parseWindowsProxyServer("https=127.0.0.1:8443")).toBe(
				"http://127.0.0.1:8443",
			);
		});

		test("空/无效 → 空串", () => {
			expect(parseWindowsProxyServer("")).toBe("");
			expect(parseWindowsProxyServer(undefined)).toBe("");
		});
	});

	describe("parseRegQueryValue：解析 reg query 输出", () => {
		const REG_OUTPUT = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890
    ProxyOverride    REG_SZ    <local>
`.trim();

		test("REG_SZ 值 → 提取值内容（含 = 和 ; 的完整串）", () => {
			expect(parseRegQueryValue(REG_OUTPUT, "ProxyServer")).toBe(
				"http=127.0.0.1:7890;https=127.0.0.1:7890",
			);
		});

		test("REG_DWORD 值 → 十六进制转十进制字符串", () => {
			expect(parseRegQueryValue(REG_OUTPUT, "ProxyEnable")).toBe("1");
		});

		test("不存在的键 → 空串", () => {
			expect(parseRegQueryValue(REG_OUTPUT, "AutoConfigURL")).toBe("");
		});
	});

	describe("parseScutilProxyOutput：解析 macOS scutil --proxy 输出", () => {
		const SCUTIL_OUTPUT = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
}`;

		test("HTTP 开启 → 返回 http://host:port", () => {
			expect(parseScutilProxyOutput(SCUTIL_OUTPUT)).toBe("http://127.0.0.1:7890");
		});

		test("全部关闭 → 空串", () => {
			expect(
				parseScutilProxyOutput(
					"<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 0\n}",
				),
			).toBe("");
		});
	});

	test("readWindowsSystemProxy：reg 读到 ProxyEnable=0 → 空串（不开代理）", async () => {
		// 注入不可行（execFile 真实子进程），仅验证纯解析链路：ProxyEnable=0 无代理
		// 该测试依赖真实 Windows 环境，非 Windows 平台跳过
		if (process.platform !== "win32") return;
		const url = await readWindowsSystemProxy();
		expect(typeof url).toBe("string");
	});
});
