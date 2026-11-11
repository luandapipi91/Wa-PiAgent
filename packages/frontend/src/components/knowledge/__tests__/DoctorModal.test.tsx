import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { DoctorModal } from "../DoctorModal";

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async () => ({
      type: "knowledge:doctor",
      report: {
        health_score: 53,
        summary: "1 个阻塞问题、1 个警告",
        issues: [
          { severity: "blocking", kbName: "产品库", message: "索引疑似卡住", action: "取消后重建" },
          { severity: "warning", kbName: "产品库", message: "3 个文件在索引后被修改", action: "运行更新" },
        ],
        diagnostics: [],
      },
    })),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    del: mock(async () => ({})),
  },
}));

beforeEach(() => cleanup());

test("诊断弹窗展示健康分与 issue 列表", async () => {
  render(<DoctorModal onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("kb-doctor-score").textContent).toBe("53"));
  expect(screen.getAllByTestId(/^kb-doctor-issue-/).length).toBe(2);
  expect(screen.getByText(/索引疑似卡住/)).toBeTruthy();
});

test("标题栏有关闭按钮，点击触发 onClose（不能只靠点遮罩退出）", async () => {
  const onClose = mock(() => {});
  render(<DoctorModal onClose={onClose} />);
  await waitFor(() => expect(screen.getByTestId("kb-doctor-score")).toBeTruthy());
  const close = screen.getByTestId("kb-doctor-close");
  fireEvent.click(close);
  expect(onClose).toHaveBeenCalledTimes(1);
});
