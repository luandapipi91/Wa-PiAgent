/**
 * 回收站消息查看端点集成测试
 *
 * 验证：删除会话(软删除) → GET /api/trash/sessions/:id/messages 能正确返回消息
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProjectStore } from "../project-store";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HttpRouter } from "../http-router";
import { readSessionHistory } from "../session-history";
import type { RouteRegistrar } from "../routes/types";

const TEST_DIR = join(tmpdir(), `test-trash-msg-${Date.now()}`);
const TEST_PROJECTS = join(TEST_DIR, "projects.json");

// 最小化的 callApi mock（不需要真实 WS server）
const mockCallApi = (async (_event: any) => Response.json({ ok: true })) as any;

async function setupRouter(store: ProjectStore) {
    const { registerProjectSessionRoutes } = await import("../routes/projects-sessions");
    const router = new HttpRouter();
    const ctx = { projectStore: store };
    registerProjectSessionRoutes(router, mockCallApi, ctx);
    return router;
}

async function createSessionWithMessages(store: ProjectStore) {
    // 创建项目和会话
    await store.createSystemProject({ id: "__system__", name: "默认工作区", cwd: TEST_DIR });
    const session = await store.createSession({
        projectId: "__system__",
        primaryAgent: "coder",
        title: "测试会话",
    });

    // 写入 jsonl 消息文件
    const dir = join(TEST_DIR, "sessions");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${session.id}.jsonl`);

    // 构造有效的 jsonl 内容（与 pi 格式一致）
    const lines = [
        JSON.stringify({ id: "entry-1", type: "message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "你好", timestamp: Date.now() } }),
        JSON.stringify({ id: "entry-2", type: "message", parentId: "entry-1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "你好！有什么可以帮你的？", timestamp: Date.now() } }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    // 手动更新 session 的 piSessionFile 路径
    const data = await store.load();
    const s = data.sessions.find(x => x.id === session.id);
    if (s) s.piSessionFile = filePath;
    // 用反射或直接操作 — 因为 save 是 private，用 loadActive 的数据不行
    // 直接写文件
    const raw = await Bun.file(TEST_PROJECTS).text();
    const parsed = JSON.parse(raw);
    parsed.sessions.find((x: any) => x.id === session.id).piSessionFile = filePath;
    await writeFile(TEST_PROJECTS, JSON.stringify(parsed, null, 2), "utf8");

    return { session, filePath };
}

describe("Trash messages endpoint", () => {
    let store: ProjectStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        process.env.WA_PI_DIR = TEST_DIR;
        store = new ProjectStore(TEST_PROJECTS);
    });

    afterEach(async () => {
        delete process.env.WA_PI_DIR;
        await rm(TEST_DIR, { force: true, recursive: true });
    });

    test("deleted session messages are readable via readSessionHistory", async () => {
        const { session, filePath } = await createSessionWithMessages(store);

        // 软删除会话
        await store.deleteSession(session.id);

        // 验证会话仍在数据中（软删除）
        const data = await store.load();
        const deleted = data.sessions.find(s => s.id === session.id);
        expect(deleted).toBeDefined();
        expect(deleted!.deletedAt).toBeGreaterThan(0);

        // 直接测试 readSessionHistory 能读取已删除会话的 jsonl
        const history = await readSessionHistory(filePath);
        expect(history.length).toBe(2);
        expect((history[0] as any).role).toBe("user");
        expect((history[1] as any).role).toBe("assistant");
    });

    test("GET /api/trash/sessions/:id/messages returns messages for deleted session", async () => {
        const { session } = await createSessionWithMessages(store);

        // 软删除
        await store.deleteSession(session.id);

        // 构造路由请求
        const router = await setupRouter(store);
        const req = new Request(`http://localhost/api/trash/sessions/${session.id}/messages`, {
            method: "GET",
        });
        const res = await router.handle(req);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(200);

        const body = await res!.json();
        expect(body.messages).toBeDefined();
        expect(body.messages.length).toBe(2);
        expect(body.messages[0].message.role).toBe("user");
        expect(body.messages[1].agentName).toBe("coder");
    });

    test("GET /api/trash/sessions/:id/messages returns empty for non-existent session", async () => {
        await createSessionWithMessages(store);
        const router = await setupRouter(store);

        const req = new Request("http://localhost/api/trash/sessions/nonexistent-id/messages", {
            method: "GET",
        });
        const res = await router.handle(req);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(200);

        const body = await res!.json();
        expect(body.messages).toEqual([]);
    });

    test("GET /api/trash/sessions/:id/messages returns empty when jsonl file missing", async () => {
        const { session } = await createSessionWithMessages(store);
        await store.deleteSession(session.id);

        // 删除 jsonl 文件
        const data = await store.load();
        const s = data.sessions.find(x => x.id === session.id);
        await rm(s!.piSessionFile, { force: true });

        const router = await setupRouter(store);
        const req = new Request(`http://localhost/api/trash/sessions/${session.id}/messages`, {
            method: "GET",
        });
        const res = await router.handle(req);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(200);

        const body = await res!.json();
        expect(body.messages).toEqual([]);
    });
});
