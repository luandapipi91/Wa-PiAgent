import { test, expect } from "bun:test";

const { useSessionStore } = await import("./session");

test("file_changes 事件写入 fileChangesBySession", () => {
	const { handleSDKEvent } = useSessionStore.getState();
	handleSDKEvent("s1", {
		type: "sdk:event",
		projectId: "p1",
		sessionId: "s1",
		agentName: "default",
		event: {
			type: "file_changes",
			files: [{ path: "/a.ts", before: "v0", after: "v1" }],
		},
	} as any);
	expect(useSessionStore.getState().fileChangesBySession["s1"]).toEqual([
		{ path: "/a.ts", before: "v0", after: "v1" },
	]);
});
