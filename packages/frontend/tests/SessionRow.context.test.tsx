import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: 0,
};

test("右键触发 onContextMenu 并阻止默认行为", () => {
  const fn = mock();
  render(
    <div>
      <SessionRow session={session} selected={false} onSelect={() => {}} onContextMenu={fn} />
    </div>
  );
  const btn = screen.getByTestId("session-s1");
  // 模拟右键事件。preventDefault 继承自 MouseEvent.prototype，bun 的 mock(obj, key)
  // 只能 patch 自有属性，故用 Object.defineProperty 在实例上覆盖成 mock。
  const event = new MouseEvent("contextmenu", { bubbles: true });
  const preventDefault = mock();
  Object.defineProperty(event, "preventDefault", { configurable: true, writable: true, value: preventDefault });
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
