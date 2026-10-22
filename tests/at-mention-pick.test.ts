/**
 * `@` 菜单「只认当前 query 的结果」（第二轮 review V5-02）
 *
 * 病灶：query 一变 → debounce(120ms) + 请求耗时窗口内，`filtered` 还是上一轮候选，
 * `pickAt(index)` 直接取 `filtered[index]`——快速键入 `@Button` 立刻 Enter 会把 `@Button`
 * 替换成上一轮第一项 `@Bar.ts`，pill 看着「很像对的」，agent 读错文件。
 *
 * 修法：结果绑定其所属 query；当前 query 与结果所属 query 不匹配 → 拒选（Enter 被拦下、
 * 菜单保持、等结果到；不放行给「提交」也不选陈旧项）；加载中有旧结果 → 列表区域降透明 + aria-busy。
 *
 * 判定全在 lib/at-mention-pick.ts（纯函数）；UI 在 node 下跑不起来（见 vitest.config.ts），
 * 接线靠源码契约兜。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  atMenuView,
  isAtResultFresh,
  normalizeAtQuery,
  pickableFor,
} from "@/lib/at-mention-pick";
import { REPO_FILES_Q_MAX_LEN } from "@/lib/repo-files-shared";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

const files = [
  { path: "src/Bar.ts", isDir: false },
  { path: "src/Baz.ts", isDir: false },
];

describe("normalizeAtQuery / isAtResultFresh", () => {
  it("请求按 REPO_FILES_Q_MAX_LEN 截断，比较也必须按同口径截断", () => {
    const long = "a".repeat(REPO_FILES_Q_MAX_LEN + 50);
    expect(normalizeAtQuery(long)).toHaveLength(REPO_FILES_Q_MAX_LEN);
    expect(isAtResultFresh(long, "a".repeat(REPO_FILES_Q_MAX_LEN))).toBe(true);
  });

  it("query 为 null（没在打 @）/ 结果为 null（还没拉到）→ 不新鲜", () => {
    expect(isAtResultFresh(null, "x")).toBe(false);
    expect(isAtResultFresh("x", null)).toBe(false);
    expect(isAtResultFresh(null, null)).toBe(false);
  });

  it("空串 query（刚打出 @）与空串结果互相匹配", () => {
    expect(isAtResultFresh("", "")).toBe(true);
  });

  it("大小写 / 前缀不算匹配：只有逐字相等才新鲜", () => {
    expect(isAtResultFresh("Button", "Butto")).toBe(false);
    expect(isAtResultFresh("button", "Button")).toBe(false);
    expect(isAtResultFresh("Bu", "Button")).toBe(false);
  });
});

describe("pickableFor：结果与当前 query 匹配才可选", () => {
  it("匹配 → 返回对应项", () => {
    expect(pickableFor("B", "B", files, 0)).toBe(files[0]);
    expect(pickableFor("B", "B", files, 1)).toBe(files[1]);
  });

  it("V5-02 主场景：query 已是 Button、结果还是上一轮（B）的 → 拒选，绝不返回 Bar.ts", () => {
    expect(pickableFor("Button", "B", files, 0)).toBeNull();
    expect(pickableFor("Button", "Bu", files, 0)).toBeNull();
  });

  it("还没有任何结果 / 没在打 @ → 拒选", () => {
    expect(pickableFor("Button", null, [], 0)).toBeNull();
    expect(pickableFor(null, "B", files, 0)).toBeNull();
  });

  it("下标越界 / 负数 / NaN / 小数 → 拒选", () => {
    expect(pickableFor("B", "B", files, 2)).toBeNull();
    expect(pickableFor("B", "B", files, -1)).toBeNull();
    expect(pickableFor("B", "B", files, Number.NaN)).toBeNull();
    expect(pickableFor("B", "B", files, 0.5)).toBeNull();
    expect(pickableFor("B", "B", [], 0)).toBeNull();
  });

  it("时序模拟：打 @B → 结果(B) → 继续打到 @Button 结果未到 → 拒选 → 结果(Button)到达 → 可选", () => {
    let results: { query: string; files: typeof files } | null = null;
    // 1) @B 的结果到达
    results = { query: "B", files };
    expect(pickableFor("B", results.query, results.files, 0)?.path).toBe(
      "src/Bar.ts",
    );
    // 2) 用户继续打到 Button；结果还是 B 的
    expect(pickableFor("Button", results.query, results.files, 0)).toBeNull();
    // 3) Button 的结果到
    results = { query: "Button", files: [{ path: "src/Button.tsx", isDir: false }] };
    expect(pickableFor("Button", results.query, results.files, 0)?.path).toBe(
      "src/Button.tsx",
    );
  });
});

describe("atMenuView：菜单四态 + 是否可选", () => {
  it("没在打 @ → closed", () => {
    expect(atMenuView(null, { query: "B", files })).toMatchObject({
      mode: "closed",
      stale: false,
      canPick: false,
      items: [],
    });
  });

  it("首次加载（没有任何结果）→ loading、stale、不可选", () => {
    expect(atMenuView("B", null)).toMatchObject({
      mode: "loading",
      stale: true,
      canPick: false,
      items: [],
    });
  });

  it("加载中且有旧结果 → 继续显示旧列表（list）、但 stale + 不可选（UI 据此降透明 / aria-busy）", () => {
    const v = atMenuView("Button", { query: "B", files });
    expect(v.mode).toBe("list");
    expect(v.stale).toBe(true);
    expect(v.canPick).toBe(false);
    expect(v.items).toBe(files);
  });

  it("旧结果为空数组、query 已变 → loading（不能把「上一轮无匹配」当成这一轮的结论）", () => {
    expect(atMenuView("Button", { query: "Butt", files: [] })).toMatchObject({
      mode: "loading",
      stale: true,
      canPick: false,
    });
  });

  it("结果与 query 匹配：有候选 → list + 可选；无候选 → empty、Enter 不该被吞", () => {
    expect(atMenuView("B", { query: "B", files })).toMatchObject({
      mode: "list",
      stale: false,
      canPick: true,
    });
    expect(atMenuView("zzz", { query: "zzz", files: [] })).toMatchObject({
      mode: "empty",
      stale: false,
      canPick: false,
    });
  });
});

describe("接线源码契约", () => {
  const at = readSrc("components", "at-mention.tsx");
  const editor = readSrc("components", "composer-editor.tsx");

  it("filtered 不再是独立 state；结果带所属 query（results state），pickAt 走 pickableFor", () => {
    expect(at).not.toContain("setFiltered");
    expect(at).not.toMatch(/useState<AtFileHit\[\]>/);
    expect(at).toMatch(/useState<AtResults \| null>/);
    expect(at).toContain("pickableFor(");
    // 不得再直接 filtered[index] 取项
    expect(at).not.toMatch(/filtered\[index\]/);
  });

  it("请求落地时把「所属 query」一并存下（用截断后的 q，与比较口径一致）", () => {
    // 第四轮 Q6-09 起走 atResultsFromOutcome(q, out)（带 failed 标记；行为见 at-mention-failed-hint.test.ts）
    expect(at).toMatch(/atResultsFromOutcome\(q,\s*out\)/);
    expect(at).toMatch(/setResults\(next\)/);
  });

  it("菜单：加载中有旧结果 → 列表容器 opacity-60 + aria-busy；降透明只落在列表区域、不落在整行 button 上", () => {
    expect(at).toContain("aria-busy");
    // 只有还画着旧列表（stale 且有项）才降透明；首次加载画 spinner、不压暗
    expect(at).toMatch(/const dim = at\.stale && hasItems/);
    expect(at).toMatch(/dim && "opacity-60"/);
    // button 的 className 里不允许 opacity-*（整行降透明属于事件流 v2 禁止项）
    const btn = at.slice(at.indexOf("<button"), at.indexOf("</button>"));
    expect(btn).not.toMatch(/opacity-/);
    // 瞬时加载态的过渡 + 减少动态效果兜底
    expect(at).toContain("transition-opacity");
    expect(at).toContain("motion-reduce:transition-none");
  });

  it("键盘：候选在路上（stale）时 Enter / Tab 也要拦下（不选、也不漏给「提交」）", () => {
    expect(at).toMatch(/!stale/);
    expect(editor).toMatch(/a\.filtered\.length > 0 \|\| a\.stale/);
  });
});
