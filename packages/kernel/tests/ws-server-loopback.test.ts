/**
 * kernel HTTP 服务监听面契约：只监听回环地址。
 *
 * 背景：单用户桌面应用，/api/* 无鉴权（文件写入、会话内容读取全在此），
 * Bun.serve 不指定 hostname 时绑定 0.0.0.0 —— 同网段任意设备可直接调 REST。
 * 本文件锁定两件事：
 *  1) 绑定地址显式为 127.0.0.1（机器没有非回环网卡时也能判定的确定性断言）
 *  2) 真实网络行为：回环可达、本机各非回环 IPv4 网卡地址不可达
 */
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import { WSServer } from "../src/ws-server";

function tmp(s: string) {
	return join(
		import.meta.dir,
		`.tmp-loopback-${s}${Math.random().toString(36).slice(2)}`,
	);
}

/** 本机所有非回环 IPv4 网卡地址（也就是「同网段其他设备能打到的那张脸」） */
function nonLoopbackIPv4(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter(
			(i): i is NonNullable<typeof i> =>
				!!i && i.family === "IPv4" && !i.internal,
		)
		.map((i) => i.address);
}

async function setup() {
	const cfgDir = tmp("cfg");
	const projDir = tmp("proj");
	const projFile = join(projDir, "projects.json");

	const server = new WSServer({
		configStore: new ConfigStore(cfgDir),
		projectStore: new ProjectStore(projFile),
		providerStore: {
			save: async () => {},
			load: async () => ({ providers: [] }),
		} as any,
		skillManager: new SkillManager(join(projDir, "skills")),
		extensionManager: {
			getEnabledExtensionSkillPaths: async () => [],
		} as any,
		memoryStore: null as any,
		agentManager: {
			markAllDirty: () => {},
			disposeAll: async () => {},
		} as any,
		channelManager: null,
		port: 0,
	});
	await server.start();

	return {
		server,
		port: server.actualPort,
		cleanup: async () => {
			await server.stop();
			rmSync(cfgDir, { recursive: true, force: true });
			rmSync(projDir, { recursive: true, force: true });
		},
	};
}

/** 能否从这个地址拿到 HTTP 响应（含非 2xx：拿到响应即说明端口可达） */
async function reachable(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
		await res.body?.cancel();
		return true;
	} catch {
		return false;
	}
}

test("Bun.serve 绑定的地址是回环 127.0.0.1", async () => {
	const ctx = await setup();
	try {
		// 不指定 hostname 时 Bun 会绑 0.0.0.0（此时 hostname 报 localhost，不能只看它）：
		// 因此这里断言的是「显式传了 hostname」的结果值
		expect((ctx.server as any).server.hostname).toBe("127.0.0.1");
	} finally {
		await ctx.cleanup();
	}
});

test("回环地址可正常访问（绑定收敛后服务本身仍可用）", async () => {
	const ctx = await setup();
	try {
		expect(await reachable(`http://127.0.0.1:${ctx.port}/api/projects`)).toBe(
			true,
		);
	} finally {
		await ctx.cleanup();
	}
});

const lanIps = nonLoopbackIPv4();

test.skipIf(lanIps.length === 0)(
	"本机非回环网卡地址不可访问（同网段设备打不到 kernel REST）",
	async () => {
		const ctx = await setup();
		try {
			for (const ip of lanIps) {
				expect(await reachable(`http://${ip}:${ctx.port}/api/projects`)).toBe(
					false,
				);
			}
		} finally {
			await ctx.cleanup();
		}
	},
);
