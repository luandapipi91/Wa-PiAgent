import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { DoctorModal } from "../DoctorModal";
import { useKnowledgeStore } from "../../../store/knowledge";

let doctorCalls = 0;
let holdNext: Promise<void> | null = null;
let releaseHold: (() => void) | null = null;

const doctorPayload = () => ({
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
});

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async (path: string) => {
      if (path === "/api/knowledge/doctor") {
        doctorCalls += 1;
        if (doctorCalls > 1 && holdNext) await holdNext;
      }
      return doctorPayload();
    }),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    del: mock(async () => ({})),
  },
}));



beforeEach(() => {
  cleanup();
  doctorCalls = 0;
  holdNext = null;
  releaseHold = null;
  useKnowledgeStore.setState({ doctor: null, doctorLoading: false, doctorUpdatedAt: null } as never);
});

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

test("点「重新诊断」有可见反馈：按钮进入诊断中并禁用，完成后展示更新时间", async () => {
  render(<DoctorModal onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("kb-doctor-score").textContent).toBe("53"));
  // 第二次请求挂住，好在「诊断中」这一刻断言
  holdNext = new Promise<void>((r) => {
    releaseHold = r;
  });
  const rerun = screen.getByTestId("kb-doctor-rerun") as HTMLButtonElement;
  fireEvent.click(rerun);
  await waitFor(() => expect(screen.getByTestId("kb-doctor-rerun").textContent).toContain("诊断中"));
  expect((screen.getByTestId("kb-doctor-rerun") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("kb-doctor-content") as HTMLElement).style.opacity).toBe("0.6");
  // 放行：状态复位 + 出现更新时间（证明本轮确实跑过）
  releaseHold!();
  await waitFor(() => expect((screen.getByTestId("kb-doctor-rerun") as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByTestId("kb-doctor-updated").textContent).toContain("更新于");
});
