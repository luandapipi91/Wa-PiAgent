// FileChangeSummary 组件测试：空清单不渲染、清单折叠行展开显示文件条目、
// 修改条目点击文件名展开 diff（ReactDiffViewer）、每项分享按钮。
//
// 注：简报提供的测试代码导入自 "vitest"，但本仓前端测试统一用 bun:test
// （package.json 的 test 脚本为 `bun test --isolate`，无 vitest 依赖）；且
// 组件清单折叠行默认折叠（open=false），文件条目需先展开清单行才渲染。
// 修改态：点击文件名展开 diff；新增/过大/失败态：点击文件名打开预览。
// 分享弹层（ShareResultModal）挂载时会调用 shareSettings，整模块 mock 隔离。
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

mock.module("../../share-client", () => ({
	shareSettings: mock(async () => ({ token: "edgeone-token", channel: "edgeone" })),
	shareUpload: mock(async () => ({})),
	saveShareSettings: async () => {},
}));

import { FileChangeSummary } from "./FileChangeSummary";
import type { FileChangeSnapshot } from "@wa-pi/shared";

const modified: FileChangeSnapshot = { path: "/a.ts", before: "const x = 1\n", after: "const x = 2\n" };
const added: FileChangeSnapshot = { path: "/b.ts", before: null, after: "new\n" };
const oversized: FileChangeSnapshot = { path: "/c.ts", before: "x", after: "y", oversized: true };
const errored: FileChangeSnapshot = { path: "/d.ts", before: "x", after: "y", error: true };

describe("FileChangeSummary", () => {
  test("空清单不渲染", () => {
    const { container } = render(<FileChangeSummary sessionId="s1" files={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("渲染文件条目与操作类型", () => {
    render(<FileChangeSummary sessionId="s1" files={[modified, added, oversized]} />);
    expect(screen.getByTestId("file-change-summary")).toBeTruthy();
    // 清单折叠行默认折叠，先展开才渲染文件条目
    fireEvent.click(screen.getByTestId("file-change-summary").querySelector("button")!);
    expect(screen.getByText("/a.ts")).toBeTruthy();
    expect(screen.getByText("/b.ts")).toBeTruthy();
  });

  test("点击修改条目展开 diff", () => {
    render(<FileChangeSummary sessionId="s1" files={[modified]} />);
    // 展开清单折叠行
    fireEvent.click(screen.getByTestId("file-change-summary").querySelector("button")!);
    // 默认折叠，diff 未挂载
    expect(document.querySelector("[data-testid='diff-/a.ts']")).toBeNull();
    // 点击文件名展开 diff（修改态）
    fireEvent.click(screen.getByText("/a.ts"));
    // 展开后渲染 diff 容器（ReactDiffViewer）
    expect(document.querySelector("[data-testid='diff-/a.ts']")).toBeTruthy();
  });

  test("正常文件项（修改/新增）显示分享按钮，error/oversized 不显示", () => {
    render(
      <FileChangeSummary
        sessionId="s1"
        files={[modified, added, oversized, errored]}
      />,
    );
    fireEvent.click(screen.getByTestId("file-change-summary").querySelector("button")!);
    // 修改态与新增态：可分享
    expect(screen.getByTestId("file-change-share-/a.ts")).toBeTruthy();
    expect(screen.getByTestId("file-change-share-/b.ts")).toBeTruthy();
    // error / oversized：不渲染分享按钮
    expect(screen.queryByTestId("file-change-share-/c.ts")).toBeNull();
    expect(screen.queryByTestId("file-change-share-/d.ts")).toBeNull();
  });

  test("点击分享按钮渲染分享弹层（ShareButton/ShareResultModal）", async () => {
    render(<FileChangeSummary sessionId="s1" files={[modified]} />);
    fireEvent.click(screen.getByTestId("file-change-summary").querySelector("button")!);
    fireEvent.click(screen.getByTestId("file-change-share-/a.ts"));
    await screen.findByTestId("share-result-modal");
    expect(screen.getByTestId("share-files")).toBeTruthy();
  });
});
