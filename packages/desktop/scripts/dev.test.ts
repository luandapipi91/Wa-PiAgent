// dev 启动器的环境隔离契约：继承来的 WA_PI_* 必须剥离，否则 dev 会加载
// 已安装应用的旧前端 / 撞正式版端口（2026-11-17 实际踩过）。
import { test, expect } from "bun:test";
import { buildDevEnv, devUserDataDir, INHERITED_KEYS, DEV_DEFAULT_PORT } from "./dev";

const HOST_ENV = {
	HOME: "/Users/x",
	PATH: "/usr/bin",
	WA_PI_WEB_DIR: "/Applications/WA PI Agent.app/Contents/Resources/web",
	WA_PI_BRIDGE_URL: "http://127.0.0.1:9778",
	WA_PI_BRIDGE_TOKEN: "secret",
	WA_PI_WS_PORT: "9778",
	WA_PI_WEB_PORT: "5180",
	WA_PI_SESSION_ID: "s-1",
	ELECTRON_RUN_AS_NODE: "1",
};

test("剥离全部继承的 WA_PI_* 与 ELECTRON_RUN_AS_NODE", () => {
	const env = buildDevEnv(HOST_ENV, "/Users/x");
	for (const key of INHERITED_KEYS) {
		expect(env[key], key).toBeUndefined();
	}
	// 普通环境变量保留（PATH/HOME 等启动必需）
	expect(env.PATH).toBe("/usr/bin");
});

test("端口与数据目录切到 dev 专用默认值", () => {
	const env = buildDevEnv(HOST_ENV, "/Users/x");
	expect(env.WA_PI_WS_PORT).toBe(DEV_DEFAULT_PORT);
	expect(env.WA_PI_WS_PORT).not.toBe("9778");
	expect(env.WA_PI_DIR).toBe("/Users/x/.wa-pi-dev");
});

test("可用 WA_PI_DEV_PORT / WA_PI_DEV_DIR 覆盖默认值", () => {
	const env = buildDevEnv(
		{ ...HOST_ENV, WA_PI_DEV_PORT: "9899", WA_PI_DEV_DIR: "/tmp/x" },
		"/Users/x",
	);
	expect(env.WA_PI_WS_PORT).toBe("9899");
	expect(env.WA_PI_DIR).toBe("/tmp/x");
});

test("userData 独立于正式版（否则单实例锁会让 dev 一启动就退出）", () => {
	expect(devUserDataDir("/Users/x")).toBe("/Users/x/.wa-pi-dev/userdata-default");
	expect(devUserDataDir("/Users/x", "b")).toBe("/Users/x/.wa-pi-dev/userdata-b");
});
