import { test, expect } from "bun:test";
import { unwrapSysTray } from "../src/util/interop";

test("unwrapSysTray: .default.default 存在时取内层", () => {
  const Ctor = function () {};
  const ns = { default: { default: Ctor } };   // bundle 后 __toESM 的形态
  expect(unwrapSysTray(ns)).toBe(Ctor);
});

test("unwrapSysTray: 仅 .default 时取它", () => {
  const Ctor = function () {};
  const ns = { default: Ctor };                 // 解释执行形态
  expect(unwrapSysTray(ns)).toBe(Ctor);
});

test("unwrapSysTray: 都没有时回退 namespace", () => {
  const Ctor = function () {};
  expect(unwrapSysTray(Ctor)).toBe(Ctor);
});
