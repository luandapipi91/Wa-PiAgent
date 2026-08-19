import { test, expect, beforeEach } from "bun:test";
import {
    COMPOSER_HEIGHT_KEY,
    COMPOSER_MIN_HEIGHT,
    clampComposerHeight,
    loadComposerHeight,
} from "../src/components/ui/useComposerHeight";

beforeEach(() => {
    localStorage.clear();
});

test("clamp：低于最小值回到 120", () => {
    expect(clampComposerHeight(10, 1000)).toBe(COMPOSER_MIN_HEIGHT);
});

test("clamp：高于视口一半回到 50vh", () => {
    expect(clampComposerHeight(9999, 1000)).toBe(500);
});

test("clamp：范围内取整保留", () => {
    expect(clampComposerHeight(200.6, 1000)).toBe(201);
});

test("load：无记录返回 null", () => {
    expect(loadComposerHeight()).toBeNull();
});

test("load：非法值返回 null", () => {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, "abc");
    expect(loadComposerHeight()).toBeNull();
    localStorage.setItem(COMPOSER_HEIGHT_KEY, "-5");
    expect(loadComposerHeight()).toBeNull();
});

test("load：合法值返回 clamp 后的数字", () => {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, "260");
    expect(loadComposerHeight()).toBe(260);
});
