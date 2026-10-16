/**
 * 列表行稳定 key 对账（S13-17）：删行后其余行 key 不变，
 * 密码框「显示明文」这类实例内状态就不会串到别的行
 */
import { describe, expect, it } from "vitest";

import { reconcileRowKeys } from "@/lib/stable-row-keys";

const sig = (r: { n: string }) => r.n;
const mk = () => {
  let i = 0;
  return () => `new-${++i}`;
};

describe("reconcileRowKeys", () => {
  const rows = [{ n: "a" }, { n: "b" }, { n: "c" }];
  const prev = { rows, keys: ["k0", "k1", "k2"] };

  it("原地编辑（行数不变）→ key 全保留", () => {
    const next = [{ n: "a" }, { n: "b2" }, { n: "c" }];
    expect(reconcileRowKeys(prev, next, sig, mk())).toEqual(["k0", "k1", "k2"]);
  });

  it("删中间行 → 其余行 key 不动（下标 key 会让 c 接管 b 的实例）", () => {
    const next = [{ n: "a" }, { n: "c" }];
    expect(reconcileRowKeys(prev, next, sig, mk())).toEqual(["k0", "k2"]);
  });

  it("删第一行 / 最后一行", () => {
    expect(
      reconcileRowKeys(prev, [{ n: "b" }, { n: "c" }], sig, mk()),
    ).toEqual(["k1", "k2"]);
    expect(
      reconcileRowKeys(prev, [{ n: "a" }, { n: "b" }], sig, mk()),
    ).toEqual(["k0", "k1"]);
  });

  it("末尾追加 → 旧 key 保留、新行发新 key", () => {
    const next = [...rows, { n: "d" }];
    expect(reconcileRowKeys(prev, next, sig, mk())).toEqual([
      "k0",
      "k1",
      "k2",
      "new-1",
    ]);
  });

  it("从空列表追加 / 一次删多行（导入覆盖）→ 全部重发 key", () => {
    expect(
      reconcileRowKeys({ rows: [], keys: [] }, [{ n: "x" }], sig, mk()),
    ).toEqual(["new-1"]);
    expect(reconcileRowKeys(prev, [{ n: "z" }], sig, mk())).toEqual(["new-1"]);
  });

  it("删光 → 空数组", () => {
    expect(
      reconcileRowKeys({ rows: [{ n: "a" }], keys: ["k0"] }, [], sig, mk()),
    ).toEqual([]);
  });
});
