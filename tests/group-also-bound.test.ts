/**
 * 手动绑群成功后「这个群还绑着别的任务」的提示文案与响应解析（B4-4 / Q12b-02）：src/lib/group-also-bound.ts
 *
 * 纯函数：
 *  - describeAlsoBoundBy：列前几个任务标题（按码点截断）、多了折成「等 N 个任务」、说清规则与怎么改；
 *  - parseAlsoBoundBy：服务端响应里的 alsoBoundBy 不是数组 / 条目残缺的一律丢弃（提示是增强信息，宁可少说不能出错）；
 *  - 客户端 bindRequirementGroup 只在非空时才把 alsoBoundBy 带进结果。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALSO_BOUND_TITLES_SHOWN,
  ALSO_BOUND_TITLE_CLIP,
  describeAlsoBoundBy,
  parseAlsoBoundBy,
} from "@/lib/group-also-bound";
import { bindRequirementGroup } from "@/lib/task-store";

const tasks = (...ids: string[]) => ids.map((id) => ({ id, title: `任务 ${id}` }));

describe("describeAlsoBoundBy", () => {
  it("没有别的任务 → 空串（调用方不该弹提示）", () => {
    expect(describeAlsoBoundBy([])).toBe("");
  });

  it("一个任务：逐字文案（规则 + 怎么改）", () => {
    expect(describeAlsoBoundBy(tasks("A"))).toBe(
      "这个群还绑着「任务 A」。群里的 @ 只会进其中一个（优先选正在运行 / 等你回答的，同档选最近更新的）；" +
        "想让群只对应一个任务，请到那边的「需求群」弹窗取消关联或换绑",
    );
  });

  it("几个任务：按传入顺序连着列", () => {
    expect(describeAlsoBoundBy(tasks("A", "B", "C"))).toContain("这个群还绑着「任务 A」「任务 B」「任务 C」。");
  });

  it(`超过 ${ALSO_BOUND_TITLES_SHOWN} 个：只列前 ${ALSO_BOUND_TITLES_SHOWN} 个，后面写「等 N 个任务」（N 是别的任务的总数）`, () => {
    const text = describeAlsoBoundBy(tasks("A", "B", "C", "D", "E"));
    expect(text).toContain("这个群还绑着「任务 A」「任务 B」「任务 C」等 5 个任务。");
    expect(text).not.toContain("「任务 D」");
  });

  it("恰好等于上限：不写「等 N 个任务」", () => {
    const text = describeAlsoBoundBy(tasks("A", "B", "C"));
    expect(text).not.toContain("等 ");
  });

  it("没标题回退显示 id；标题首尾空白去掉", () => {
    expect(describeAlsoBoundBy([{ id: "t_x", title: "  " }])).toContain("「t_x」");
    expect(describeAlsoBoundBy([{ id: "t_x", title: "  登录优化 " }])).toContain("「登录优化」");
  });

  it(`标题超过 ${ALSO_BOUND_TITLE_CLIP} 个字按码点截断，不切开 emoji`, () => {
    const long = `${"字".repeat(ALSO_BOUND_TITLE_CLIP - 1)}😀尾巴`;
    const text = describeAlsoBoundBy([{ id: "t_x", title: long }]);
    expect(text).toContain(`「${"字".repeat(ALSO_BOUND_TITLE_CLIP - 1)}😀…」`);
    expect(text).not.toContain("尾巴");
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false);
  });

  it("截断长度就是 20 个字：用字面量钉住数值、不跟着导出常量走（20 个字原样，21 个字截成 20 个 + …）", () => {
    const exact = "字".repeat(20);
    expect(describeAlsoBoundBy([{ id: "t_x", title: exact }])).toContain(`「${exact}」`);
    const text = describeAlsoBoundBy([{ id: "t_x", title: "字".repeat(21) }]);
    expect(text).toContain(`「${"字".repeat(20)}…」`);
    expect(text).not.toContain("字".repeat(21));
  });
});

describe("parseAlsoBoundBy", () => {
  it("正常条目原样保留（顺序不变）", () => {
    expect(parseAlsoBoundBy([{ id: "a", title: "甲" }, { id: "b", title: "乙" }])).toEqual([
      { id: "a", title: "甲" },
      { id: "b", title: "乙" },
    ]);
  });

  it("不是数组 → 空", () => {
    for (const bad of [undefined, null, "x", 3, {}, { id: "a", title: "甲" }]) {
      expect(parseAlsoBoundBy(bad), JSON.stringify(bad)).toEqual([]);
    }
  });

  it("条目残缺 / 类型不对的丢弃，其余保留；缺标题的补空串", () => {
    expect(
      parseAlsoBoundBy([null, 5, "s", {}, { id: "" }, { id: 7 }, { id: "ok" }, { id: "t", title: 9 }, { id: "z", title: "丙" }]),
    ).toEqual([
      { id: "ok", title: "" },
      { id: "t", title: "" },
      { id: "z", title: "丙" },
    ]);
  });
});

describe("客户端 bindRequirementGroup：alsoBoundBy 只在非空时带进结果", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (body: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  };
  const okBody = { ok: true, chatId: "oc_x", overwritten: false, task: { id: "t1" } };

  it("响应带 alsoBoundBy → 结果里有（经过解析）", async () => {
    stubFetch({ ...okBody, alsoBoundBy: [{ id: "a", title: "甲" }, { nope: true }] });
    const r = await bindRequirementGroup("t1", "oc_x");
    expect(r.ok).toBe(true);
    expect(r.ok && r.alsoBoundBy).toEqual([{ id: "a", title: "甲" }]);
  });

  it("响应没带 / 空数组 / 全是残缺条目 → 结果里没有 alsoBoundBy 这个键", async () => {
    for (const extra of [{}, { alsoBoundBy: [] }, { alsoBoundBy: [{}] }, { alsoBoundBy: "x" }]) {
      stubFetch({ ...okBody, ...extra });
      const r = await bindRequirementGroup("t1", "oc_x");
      expect(r.ok, JSON.stringify(extra)).toBe(true);
      expect("alsoBoundBy" in r, JSON.stringify(extra)).toBe(false);
    }
  });
});
