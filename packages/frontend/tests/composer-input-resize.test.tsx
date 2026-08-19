// ComposerInput 手动调高接线测试：
// 拖拽手柄 → textbox 固定高度 + localStorage 写穿；localStorage 有记录时初始即固定高度
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

const getMock = mock();
mock.module("../src/api-client", () => ({
    api: {
        get: getMock,
        post: () => Promise.resolve({}),
        put: () => Promise.resolve({}),
        del: () => Promise.resolve({}),
    },
}));

import { ComposerInput } from "../src/components/ui/ComposerInput";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useSkillsStore } from "../src/store/skills";
import { useAgentsStore } from "../src/store/agents";
import { useCommandsStore } from "../src/store/commands";
import { useSessionStore } from "../src/store/session";
import { COMPOSER_HEIGHT_KEY } from "../src/components/ui/useComposerHeight";

function seedStores() {
    useProjectsStore.setState({
        projects: [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }] as any,
        sessions: [],
        currentProjectId: "proj-1",
        currentSessionId: null,
    } as any);
    useProvidersStore.setState({ providers: [] } as any);
    useSkillsStore.setState({ allSkills: [], skills: [], dirs: [], disabledSkills: [], builtinDir: "" } as any);
    useAgentsStore.setState({ list: [] } as any);
    useCommandsStore.setState({ commands: [], load: mock(() => {}) } as any);
    useSessionStore.setState({ openFilePreview: mock(() => {}) } as any);
}

function renderComposer() {
    return render(
        <ComposerInput
            text=""
            setText={() => {}}
            model={null}
            setModel={() => {}}
            thinking="high"
            setThinking={() => {}}
            attachments={[]}
            setAttachments={() => {}}
            projectId="proj-1"
            sessionId="s1"
            onSend={() => {}}
            isNewSession
            modelAutoSelectEnabled
        />,
    );
}

beforeEach(() => {
    localStorage.clear();
    getMock.mockImplementation(async () => ({}));
    seedStores();
});

afterEach(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
});

test("渲染拖拽手柄", () => {
    renderComposer();
    expect(screen.getByTestId("composer-resize-handle")).toBeTruthy();
});

test("向上拖 80px：textbox 固定为 140px 并写入 localStorage", () => {
    renderComposer();
    const textbox = screen.getByRole("textbox");
    textbox.getBoundingClientRect = () =>
        ({ height: 60, top: 0, left: 0, right: 0, bottom: 60, width: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const handle = screen.getByTestId("composer-resize-handle");
    fireEvent.mouseDown(handle, { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 220 });
    fireEvent.mouseUp(window);
    expect(textbox.style.height).toBe("140px");
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBe("140");
});

test("localStorage 已有记录：初始即固定高度", () => {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, "200");
    renderComposer();
    expect(screen.getByRole("textbox").style.height).toBe("200px");
});

test("双击手柄重置：回到自然生长并移除 localStorage 记录", () => {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, "200");
    renderComposer();
    const textbox = screen.getByRole("textbox");
    expect(textbox.style.height).toBe("200px");
    fireEvent.doubleClick(screen.getByTestId("composer-resize-handle"));
    expect(textbox.style.height).toBe("");
    expect(textbox.style.minHeight).toBe("60px");
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBeNull();
});
