import { expect, test } from "bun:test";
import { sliceHistory } from "../src/util/slice-history";

test("sliceHistory：未传 max 原样返回；超出则保留末尾 N 条", () => {
	const msgs = Array.from({ length: 150 }, (_, i) => ({ id: i }));
	expect(sliceHistory(msgs)).toHaveLength(150);
	const sliced = sliceHistory(msgs, 100);
	expect(sliced).toHaveLength(100);
	expect(sliced[0].id).toBe(50);
	expect(sliceHistory([{ id: 1 }], 100)).toHaveLength(1);
});
