import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
});
