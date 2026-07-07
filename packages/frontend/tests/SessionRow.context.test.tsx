import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: 0,
};

test("右键触发 onContextMenu 并阻止默认行为", () => {
  const fn = vi.fn();
  render(
    <div>
      <SessionRow session={session} selected={false} onSelect={() => {}} onContextMenu={fn} />
    </div>
  );
  const btn = screen.getByTestId("session-s1");
  // 模拟右键事件
  const event = new MouseEvent("contextmenu", { bubbles: true });
  const preventDefault = vi.spyOn(event, "preventDefault");
  fireEvent(btn, event);
  expect(preventDefault).toHaveBeenCalled();
  expect(fn).toHaveBeenCalledTimes(1);
  // 回调第二个参数是 session 对象
  expect(fn.mock.calls[0][1]).toMatchObject({ id: "s1" });
});

test("未传 onContextMenu 时右键不报错（仅阻止默认）", () => {
  render(
    <div>
      <SessionRow session={session} selected={false} onSelect={() => {}} />
    </div>
  );
  const btn = screen.getByTestId("session-s1");
  expect(() => fireEvent.contextMenu(btn)).not.toThrow();
});
