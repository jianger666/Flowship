/**
 * 第五轮 review G1-07（补充）：入向卡片净化里「带名字的 open_id 占位」正则的二次型。
 *
 * 与 tests/inbound-card-sanitize-r5.test.ts 的区别：那边覆盖拆壳 / 面板 / 常见病态串，
 * 这里专门钉 `@名字(ou_…)` 这一条——它要「紧跟 `(ou_` 之后一路扫到 `)` 或空白」才算收尾，
 * 重复的 `@a(ou_`（既没有 `)` 也没有空白）会让每个 `@` 都扫一遍到文末。
 *
 * 预算说明：不是性能基准，是「慢出几个数量级」的探测（线性实现是毫秒级、二次型是数秒）。
 */
import { describe, expect, it } from "vitest";

import {
  replaceOpenIdPlaceholders,
  sanitizeInboundCardText,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";

const BUDGET_MS = 1000;
const timed = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("G1-07 · 带名字的 open_id 占位在病态串上有界", () => {
  it("重复的 `@a(ou_`（半角 / 全角括号）没有收尾括号也没有空白", () => {
    for (const open of ["(", "（"]) {
      const evil = `@a${open}ou_`.repeat(18_000);
      expect(
        timed(() => sanitizeInboundCardText(evil)),
        `open=${open}`,
      ).toBeLessThan(BUDGET_MS);
    }
  });

  it("语义不变：带名字的占位去掉括号里的 id（半角 / 全角 / 完整 open_id）", () => {
    expect(replaceOpenIdPlaceholders("@李安(ou_dd96…) 好", () => undefined)).toBe(
      "@李安 好",
    );
    expect(
      replaceOpenIdPlaceholders("@李安（ou_dd96abcdef）好", () => undefined),
    ).toBe("@李安好");
    expect(
      replaceOpenIdPlaceholders(
        "@李安(ou_3c5a3c78eadf40138676d3f268503064) 好",
        () => undefined,
      ),
    ).toBe("@李安 好");
  });
});
