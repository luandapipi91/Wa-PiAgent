import { test, expect } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useAutoCollapse } from "../src/components/blocks/useAutoCollapse";

test("流式中未完成 → 默认展开", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  expect(result.current.open).toBe(true);
});

test("完成后 → 自动折叠", () => {
  const { result, rerender } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  rerender({ isStreaming: true, isDone: true });
  expect(result.current.open).toBe(false);
});

test("历史（非流式）→ 默认折叠", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: true } });
  expect(result.current.open).toBe(false);
});

test("流式展开中 toggle 一次即折叠（回归：不得要点两次）", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  expect(result.current.open).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.open).toBe(false);
});

test("用户 toggle 后，自动逻辑不再覆盖", () => {
  const { result, rerender } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: true } });
  act(() => result.current.toggle()); // 用户手动展开
  expect(result.current.open).toBe(true);
  rerender({ isStreaming: true, isDone: false }); // 自动逻辑想让它展开/折叠都不再生效
  rerender({ isStreaming: false, isDone: true });
  expect(result.current.open).toBe(true);
});

test("executingMode + 未完成（即使非流式）→ 默认展开", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: false, executingMode: true } });
  expect(result.current.open).toBe(true);
});

test("executingMode + 完成 → 自动折叠", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: true, executingMode: true } });
  expect(result.current.open).toBe(false);
});

test("executingMode=false（默认）：非流式未完成 → 折叠", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: false } });
  expect(result.current.open).toBe(false);
});
