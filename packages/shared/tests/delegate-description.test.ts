import { describe, expect, test } from "bun:test";
import { DELEGATE_DESCRIPTION } from "../src/tool-schemas";

/**
 * 委派路由判据：专项优先（2026-10-29 bug 修复）
 * 设计意图：任务落在任一领域专员的覆盖范围时，优先派该专员；
 * 通用智能体（general-purpose）只兜底没有专员覆盖的多步执行任务。
 * 回归背景：旧判据「多步带写 → general-purpose」导致通用代理吃掉一切，
 * 9 个领域专员在真实流量里几乎零调用（最近 100 次委派专员合计 1 次）。
 */
describe("DELEGATE_DESCRIPTION 专项优先判据", () => {
  test("包含专项优先规则：领域命中时优先派专员", () => {
    expect(DELEGATE_DESCRIPTION).toMatch(/专项优先/);
    expect(DELEGATE_DESCRIPTION).toMatch(/优先派(该|对应)专员/);
  });

  test("明确通用智能体的兜底定位：只接没有专员覆盖的任务", () => {
    expect(DELEGATE_DESCRIPTION).toMatch(/兜底/);
  });

  test("旧的一般优先判据已移除，不再把多步带写无条件导向 general-purpose", () => {
    expect(DELEGATE_DESCRIPTION).not.toMatch(/多步带写\s*→\s*general-purpose/);
  });

  test("领域枚举以省略号结尾，表明非穷举、以名单字段为准", () => {
    expect(DELEGATE_DESCRIPTION).toMatch(/任务拆解…）/);
  });
});
