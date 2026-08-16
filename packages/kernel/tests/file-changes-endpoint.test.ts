import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WSServer, type WSServerOpts } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { getBridgeToken } from "../src/bridge-registry";
import { openSse, readSseFrame } from "./helpers/http-api-kit";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "fc-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

async function startTestServer(extraOpts: Partial<WSServerOpts> = {}) {
	const rand = () => join(tmpDir, "ws-" + Math.random().toString(36).slice(2));
	const server = new WSServer({
		configStore: new ConfigStore(rand()),
		projectStore: new ProjectStore(rand() + ".json"),
		providerStore: new ProviderStore(rand() + ".json"),
		skillManager: new SkillManager(rand()),
		extensionManager: new ExtensionManager(rand()),
		memoryStore: null as any,
		mcpStore: null as any,
		dataDir: rand(),
		agentManager: { disposeAll: async () => {} } as any,
		channelManager: null,
		port: 0,
		...extraOpts,
	});
	await server.start();
	return { server, port: server.actualPort };
}

test("/bridge/file-changes：错误 token → 403", async () => {
	const { server, port } = await startTestServer();
	try {
		const res = await fetch(`http://127.0.0.1:${port}/bridge/file-changes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "wrong", sessionId: "s1", files: [] }),
		});
		expect(res.status).toBe(403);
	} finally {
		await server.stop();
	}
});

test("/bridge/file-changes：正确 token → 200 且广播 file_changes 事件", async () => {
	const { server, port } = await startTestServer({
		agentManager: {
			disposeAll: async () => {},
			getSessionMeta: (sid: string) =>
				sid === "s1" ? { projectId: "p1", agentName: "default" as const } : undefined,
		} as any,
	});
	const reader = await openSse(`http://127.0.0.1:${port}`);
	try {
		const files = [{ path: "/a.ts", before: "v0", after: "v1" }];
		const res = await fetch(`http://127.0.0.1:${port}/bridge/file-changes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: getBridgeToken(), sessionId: "s1", files }),
		});
		expect(res.status).toBe(200);
		const frame = await readSseFrame(reader);
		expect(frame.data.type).toBe("sdk:event");
		expect(frame.data.event.type).toBe("file_changes");
		expect(frame.data.event.files).toEqual(files);
	} finally {
		await server.stop();
	}
});
