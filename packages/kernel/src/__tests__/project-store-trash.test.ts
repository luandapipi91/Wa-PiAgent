import { describe, test, expect, afterEach } from "bun:test";
import { ProjectStore } from "../project-store";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_FILE = join(tmpdir(), `test-trash-${Date.now()}.json`);

function makeStore() {
    return new ProjectStore(TEST_FILE);
}

async function seed(s: ProjectStore) {
    await s.createSystemProject({ id: "__system__", name: "默认工作区", cwd: "/tmp" });
    const p = await s.createProject({ name: "ProjA", cwd: "/tmp/a" });
    const s1 = await s.createSession({ projectId: "__system__", primaryAgent: "coder", title: "S1" });
    const s2 = await s.createSession({ projectId: p.id, primaryAgent: "coder", title: "S2" });
    return { p, s1, s2 };
}

describe("ProjectStore soft delete", () => {
    afterEach(async () => { await rm(TEST_FILE, { force: true }); });

    test("deleteProject soft-deletes active sessions instead of physically removing them", async () => {
        const s = makeStore();
        const { p, s2 } = await seed(s);
        await s.deleteProject(p.id);
        const data = await s.load();
        // 项目被删除
        expect(data.projects.find(x => x.id === p.id)).toBeUndefined();
        // 会话记录仍在（软删除），且有 deletedAt
        const found = data.sessions.find(x => x.id === s2.id);
        expect(found).toBeDefined();
        expect(found!.deletedAt).toBeGreaterThan(0);
        expect(found!.deletedReason).toBe("manual");
    });

    test("deleteProject does not re-delete already-deleted sessions", async () => {
        const s = makeStore();
        const { p, s2 } = await seed(s);
        // 先手动软删除
        await s.deleteSession(s2.id);
        const data1 = await s.load();
        const firstDeletedAt = data1.sessions.find(x => x.id === s2.id)!.deletedAt;
        // 删除项目
        await s.deleteProject(p.id);
        const data2 = await s.load();
        const found = data2.sessions.find(x => x.id === s2.id);
        // deletedAt 不应被覆盖
        expect(found!.deletedAt).toBe(firstDeletedAt);
    });

    test("deleteProject soft-deleted sessions appear in trash", async () => {
        const s = makeStore();
        const { p, s2 } = await seed(s);
        await s.deleteProject(p.id);
        const trash = await s.loadTrash();
        expect(trash.total).toBe(1);
        expect(trash.sessions.find(x => x.id === s2.id)).toBeDefined();
    });

    test("deleteSession sets deletedAt instead of removing", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id);
        const data = await s.load();
        const found = data.sessions.find(x => x.id === s1.id);
        expect(found).toBeDefined();
        expect(found!.deletedAt).toBeGreaterThan(0);
        expect(found!.deletedReason).toBe("manual");
    });

    test("restoreSession clears deletedAt", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.restoreSession(s1.id);
        const data = await s.load();
        const found = data.sessions.find(x => x.id === s1.id);
        expect(found!.deletedAt).toBeUndefined();
        expect(found!.deletedReason).toBeUndefined();
    });

    test("restoreSession on non-deleted session is no-op", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.restoreSession(s1.id);
        const data = await s.load();
        expect(data.sessions.find(x => x.id === s1.id)).toBeDefined();
    });

    test("permanentlyDeleteSessions removes records", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.permanentlyDeleteSessions([s1.id, s2.id]);
        const data = await s.load();
        expect(data.sessions.find(x => x.id === s1.id)).toBeUndefined();
        expect(data.sessions.find(x => x.id === s2.id)).toBeUndefined();
    });

    test("permanentlyDeleteSessions with non-existent id is no-op", async () => {
        const s = makeStore();
        await seed(s);
        await s.permanentlyDeleteSessions(["nonexistent"]);
        const data = await s.load();
        expect(data.sessions.length).toBeGreaterThan(0);
    });

    test("emptyTrash removes all deleted sessions", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.deleteSession(s2.id);
        const removed = await s.emptyTrash();
        expect(removed).toBe(2);
        const data = await s.load();
        expect(data.sessions.length).toBe(0);
    });

    test("emptyTrash with no deleted sessions returns 0", async () => {
        const s = makeStore();
        await seed(s);
        const removed = await s.emptyTrash();
        expect(removed).toBe(0);
    });

    test("loadActive returns only non-deleted sessions", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        const data = await s.loadActive();
        expect(data.sessions.length).toBe(1);
        expect(data.sessions[0].id).toBe(s2.id);
    });

    test("restoreSession assigns SYSTEM_PROJECT_ID when original project deleted", async () => {
        const s = makeStore();
        const { s2 } = await seed(s);
        // 软删除会话
        await s.deleteSession(s2.id);
        // 模拟原项目已删除：将 projectId 重指向不存在的项目。
        // 注：deleteProject 会软删除（移入回收站）该项目下所有会话，
        // 无法用它直接制造已软删除但原项目不存在的场景，
        // 故用 reassignSession（文档即“孤儿 session 归入默认项目”）制造孤儿场景，
        // 以覆盖 restoreSession 的孤儿恢复分支。
        await s.reassignSession(s2.id, "deleted-project-id");
        // 恢复 —— 原项目不存在，应归入默认工作区
        await s.restoreSession(s2.id);
        const data = await s.load();
        const found = data.sessions.find(x => x.id === s2.id);
        expect(found!.projectId).toBe("__system__");
        expect(found!.deletedAt).toBeUndefined();
    });

    test("loadTrash returns only deleted sessions with total", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.deleteSession(s2.id);
        const result = await s.loadTrash();
        expect(result.total).toBe(2);
        expect(result.sessions.length).toBe(2);
    });

    test("loadTrash filters by projectId", async () => {
        const s = makeStore();
        const { p, s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.deleteSession(s2.id);
        const result = await s.loadTrash({ projectId: p.id });
        expect(result.total).toBe(1);
        expect(result.sessions[0].id).toBe(s2.id);
    });

    test("loadTrash paginates with offset/limit", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.deleteSession(s2.id);
        const page1 = await s.loadTrash({ offset: 0, limit: 1 });
        expect(page1.sessions.length).toBe(1);
        expect(page1.total).toBe(2);
        const page2 = await s.loadTrash({ offset: 1, limit: 1 });
        expect(page2.sessions.length).toBe(1);
        expect(page2.sessions[0].id).not.toBe(page1.sessions[0].id);
    });

    test("loadTrash returns empty when no deleted sessions", async () => {
        const s = makeStore();
        await seed(s);
        const result = await s.loadTrash();
        expect(result.total).toBe(0);
        expect(result.sessions.length).toBe(0);
    });

    test("archiveStaleSessions archives inactive sessions", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        // 手动设置 lastActivity 为 10 天前
        const data = await s.load();
        const session = data.sessions.find(x => x.id === s1.id);
        session!.lastActivity = Date.now() - 10 * 24 * 60 * 60 * 1000;
        await s.save(data);
        // 7 天阈值
        const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
        expect(archived.length).toBe(1);
        expect(archived[0].id).toBe(s1.id);
        expect(archived[0].deletedReason).toBe("auto");
    });

    test("archiveStaleSessions does not archive already-deleted sessions", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        const data = await s.load();
        data.sessions.find(x => x.id === s2.id)!.lastActivity = Date.now() - 10 * 24 * 60 * 60 * 1000;
        await s.save(data);
        const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
        expect(archived.length).toBe(1);
        expect(archived[0].id).toBe(s2.id);
    });

    test("archiveStaleSessions respects threshold", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        const data = await s.load();
        data.sessions.find(x => x.id === s1.id)!.lastActivity = Date.now() - 3 * 24 * 60 * 60 * 1000;
        await s.save(data);
        const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
        expect(archived.length).toBe(0);
    });

    test("purgeOldTrashSessions permanently deletes old trash", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id);
        // 手动设置 deletedAt 为 40 天前
        const data = await s.load();
        data.sessions.find(x => x.id === s1.id)!.deletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
        await s.save(data);
        const purged = await s.purgeOldTrashSessions(Date.now() - 30 * 24 * 60 * 60 * 1000);
        expect(purged).toBe(1);
        const after = await s.load();
        expect(after.sessions.find(x => x.id === s1.id)).toBeUndefined();
    });

    test("purgeOldTrashSessions keeps recent trash", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id); // deletedAt = now
        const purged = await s.purgeOldTrashSessions(Date.now() - 30 * 24 * 60 * 60 * 1000);
        expect(purged).toBe(0);
    });
});
