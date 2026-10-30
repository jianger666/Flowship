/**
 * Q10-05 / Q21-02 的前端部分：提示文案决策（纯函数，行为测）+ 面板 / hook 接线（源码契约）。
 *
 * ⚠ 面板没有 jsdom 可渲染：这里的接线契约只证明「语句还在、位置对」，证明不了渲染 / 点击时按钮真的变灰、真的转圈；
 *   行为能测的部分已抽出来单测：提示文案是纯函数（describeMergeSuccess / describeRegressionTransition），
 *   合并 hook 的逻辑（取消 / 双击 / 请求进行中 / 解锁 / 提示）在 use-merge-mr-behavior.test.ts 里用 SSR 探针测。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeMergeSuccess,
  describeRegressionTransition,
} from "@/lib/mr-inbox-messages";

const read = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("describeMergeSuccess：已合并过要换一句更准的话", () => {
  it("真的合了：MR 已合并", () => {
    expect(describeMergeSuccess({ alreadyMerged: false })).toBe("MR 已合并");
  });
  it("双击 / 两个窗口 / 别人先合了：不说「已合并」（不是你这次合的），说已合并过 + 已更新列表", () => {
    expect(describeMergeSuccess({ alreadyMerged: true })).toBe(
      "该 MR 已经合并过了，已为你更新列表",
    );
  });
});

describe("describeRegressionTransition：不通过的评论没发出去 → warning", () => {
  it("通过：success", () => {
    expect(describeRegressionTransition("pass", {})).toEqual({
      level: "success",
      text: "已标记通过并关闭",
    });
  });
  it("通过不发评论：就算响应误带 commentFailed 也不该报 warning", () => {
    expect(describeRegressionTransition("pass", { commentFailed: true }).level).toBe(
      "success",
    );
  });
  it("不通过、评论发出去了：success", () => {
    expect(describeRegressionTransition("reject", {})).toEqual({
      level: "success",
      text: "已打回并写评论",
    });
    expect(describeRegressionTransition("reject", { commentFailed: false }).level).toBe(
      "success",
    );
  });
  it("不通过、已流转但评论没发出去：warning，且不再说「已写评论」", () => {
    const t = describeRegressionTransition("reject", { commentFailed: true });
    expect(t.level).toBe("warning");
    expect(t.text).toBe("已打回，但原因评论没发出去，请到飞书补发");
    expect(t.text).not.toContain("已打回并写评论");
  });
});

describe("接线契约（源码）", () => {
  const panel = read("src/components/mr-inbox/mr-inbox-panel.tsx");
  const action = read("src/hooks/use-merge-mr.ts");
  const inboxHook = read("src/hooks/use-mr-inbox.tsx");

  it("去重：两个 Row 都走 useMergeMr；确认框 + 请求 + toast 只在共享 hook 里有一份", () => {
    expect(panel.match(/useMergeMr\(\)/g)).toHaveLength(2);
    expect(panel.match(/const handleMerge = /g)).toHaveLength(2);
    expect(panel).not.toMatch(/const handleMerge = async/);
    expect(panel).not.toContain('title: "合并这个 MR？"');
    expect(action.match(/title: "合并这个 MR？"/g)).toHaveLength(1);
    expect(action).toContain("`合并失败：${err instanceof Error ? err.message : String(err)}`");
  });

  it("防重入：同步闸在确认框之前上锁、之后在 finally 里解锁（双击不弹两个确认框）", () => {
    const lock = action.indexOf("busyRef.current = true");
    const confirmAt = action.indexOf("await confirm(");
    const unlock = action.indexOf("busyRef.current = false");
    expect(action).toMatch(/if \(busyRef\.current\) return;/);
    expect(lock).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(lock);
    expect(unlock).toBeGreaterThan(confirmAt);
    expect(action.slice(action.lastIndexOf("finally", unlock), unlock)).toMatch(/finally \{\s*$/);
  });

  it("已合并过的提示：hook 把 alreadyMerged 带回来，共享 hook 用 describeMergeSuccess 出文案", () => {
    expect(inboxHook).toContain(
      "return { alreadyMerged: merged.alreadyMerged === true };",
    );
    expect(action).toContain("toast.success(describeMergeSuccess(result));");
  });

  it("Q21-02：transitionBug 把 commentFailed 带回来；面板用 describeRegressionTransition 出提示，warning 带「去飞书」", () => {
    expect(inboxHook).toContain(
      "...(body.commentFailed === true ? { commentFailed: true } : {}),",
    );
    expect(panel).toContain("describeRegressionTransition(action, result)");
    // 「去飞书」按钮必须就挂在这条 warning 上（面板里别处另有两个同名按钮，不能只看全文有没有）
    expect(panel).toMatch(
      /toast\.warning\(outcome\.text,\s*\{\s*action:\s*\{\s*label:\s*"去飞书",\s*onClick:\s*\(\) =>\s*\{\s*window\.open\(entry\.bugUrl,/,
    );
    // 文案只在纯函数里一份：面板里不能再有写死的「已打回并写评论」
    expect(panel).not.toContain("已打回并写评论");
  });

  it("忙碌态：合并 hook 在发请求前置 merging、在 finally 里复位（按钮变灰 + 转圈靠它）", () => {
    const on = action.indexOf("setMerging(true)");
    const call = action.indexOf("await mergeMr(");
    const off = action.indexOf("setMerging(false)");
    expect(on).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(on);
    expect(off).toBeGreaterThan(call);
    expect(action.slice(action.lastIndexOf("finally", off), off)).toMatch(/finally \{\s*$/);
  });

  it("忙碌态：待回归行的三个按钮在 pass / reject 进行中或合并进行中都禁用，待测 MR 行的合并按钮在合并中禁用", () => {
    expect(panel.match(/disabled=\{busy !== null \|\| merging\}/g)).toHaveLength(3);
    expect(panel.match(/disabled=\{merging\}/g)).toHaveLength(1);
    // 转圈来自 hook 的 merging（不再有 busy === "merge" 这种本地状态）
    expect(panel.match(/\{merging \? \(/g)).toHaveLength(2);
    expect(panel).not.toContain('busy === "merge"');
  });
});
