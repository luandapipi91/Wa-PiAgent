import { test, expect } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useSettled } from "../../src/components/blocks/useSettled";

test("值停顿 idleMs 后 settled=true；值变化立即重置为 false", async () => {
  const { result, rerender } = renderHook(({ v }) => useSettled(v, 20), {
    initialProps: { v: "a" },
  });
  expect(result.current).toBe(false);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(result.current).toBe(true);
  rerender({ v: "ab" });
  expect(result.current).toBe(false);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(result.current).toBe(true);
});
