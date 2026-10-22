/**
 * R9a-04：损坏任务提示的「忽略」记忆——纯函数 + 假 storage 行为测试
 */
import { describe, expect, it } from "vitest";

import type { CorruptTaskInfo } from "@/lib/corrupt-task";
import {
  CORRUPT_DISMISSED_KEY,
  CORRUPT_DISMISSED_MAX,
  corruptDismissKey,
  dismissCorrupt,
  pruneDismissedCorrupt,
  readDismissedCorrupt,
  visibleCorruptTasks,
  writeDismissedCorrupt,
  type DismissStorage,
} from "@/lib/corrupt-task-dismiss";

const info = (id: string, kind: CorruptTaskInfo["kind"] = "schema_mismatch"): CorruptTaskInfo => ({
  id,
  kind,
  reason: "x",
  metaPath: `/data/tasks/${id}/meta.json`,
  backupValid: false,
});

const memStorage = (initial?: string): DismissStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(CORRUPT_DISMISSED_KEY, initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

describe("corrupt-task-dismiss", () => {
  it("被忽略的条目不再可见；其它条目保留", () => {
    const list = [info("t_a"), info("t_b"), info("t_c", "empty")];
    const dismissed = dismissCorrupt([], [list[0]!, list[2]!]);
    expect(visibleCorruptTasks(list, dismissed).map((c) => c.id)).toEqual(["t_b"]);
  });

  it("同一任务换了损坏类别 → 作为新问题重新亮出来", () => {
    const dismissed = dismissCorrupt([], [info("t_a", "empty")]);
    expect(visibleCorruptTasks([info("t_a", "empty")], dismissed)).toHaveLength(0);
    expect(visibleCorruptTasks([info("t_a", "invalid_json")], dismissed)).toHaveLength(1);
  });

  it("dismissCorrupt 去重", () => {
    const once = dismissCorrupt([], [info("t_a")]);
    expect(dismissCorrupt(once, [info("t_a")])).toEqual(once);
  });

  it("读写往返；坏数据 / 非数组 / 无 storage 一律回空、不抛", () => {
    const s = memStorage();
    writeDismissedCorrupt(s, [corruptDismissKey(info("t_a"))]);
    expect(readDismissedCorrupt(s)).toEqual(["t_a|schema_mismatch"]);
    expect(readDismissedCorrupt(memStorage("{not json"))).toEqual([]);
    expect(readDismissedCorrupt(memStorage('{"a":1}'))).toEqual([]);
    expect(readDismissedCorrupt(memStorage('[1,"ok",""]'))).toEqual(["ok"]);
    expect(readDismissedCorrupt(null)).toEqual([]);
    expect(() => writeDismissedCorrupt(null, ["x"])).not.toThrow();
  });

  it("setItem 抛错（隐私模式 / 配额）不向外抛", () => {
    const s: DismissStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeDismissedCorrupt(s, ["a|empty"])).not.toThrow();
  });

  it("写入有上限，留最新的", () => {
    const s = memStorage();
    const many = Array.from({ length: CORRUPT_DISMISSED_MAX + 5 }, (_, i) => `t_${i}|empty`);
    writeDismissedCorrupt(s, many);
    const back = readDismissedCorrupt(s);
    expect(back).toHaveLength(CORRUPT_DISMISSED_MAX);
    expect(back.at(-1)).toBe(`t_${CORRUPT_DISMISSED_MAX + 4}|empty`);
  });

  it("prune：修好的任务清掉忽略记录；列表不可信（还没加载 / 拉取失败）的空列表不清", () => {
    const dismissed = ["t_a|empty", "t_b|empty"];
    expect(pruneDismissedCorrupt(dismissed, [info("t_a", "empty")])).toEqual(["t_a|empty"]);
    // 缺省 / listTrusted:false：空列表可能只是「还没加载」，清了会把用户的忽略全丢
    expect(pruneDismissedCorrupt(dismissed, [])).toEqual(dismissed);
    expect(pruneDismissedCorrupt(dismissed, [], { listTrusted: false })).toEqual(dismissed);
  });

  it("Q8-04：列表可信（已加载且没失败）时空列表也清——唯一一条被忽略的任务修好后，同类别再坏会重新提示", () => {
    // 复现原场景：忽略唯一一条 → 修好（列表变空）→ 同 id 同类别再损坏
    const dismissed = dismissCorrupt([], [info("t_x", "schema_mismatch")]);
    const pruned = pruneDismissedCorrupt(dismissed, [], { listTrusted: true });
    expect(pruned).toEqual([]);
    // 再坏：不再被旧的忽略记录挡住
    expect(visibleCorruptTasks([info("t_x", "schema_mismatch")], pruned)).toHaveLength(1);
    // 反例：不清的旧树行为下它会被继续挡住（保守路径仍是这样）
    const kept = pruneDismissedCorrupt(dismissed, [], { listTrusted: false });
    expect(visibleCorruptTasks([info("t_x", "schema_mismatch")], kept)).toHaveLength(0);
  });

  it("Q8-04：可信的非空列表仍只保留还在坏的那几条（不会误清）", () => {
    const dismissed = ["t_a|empty", "t_b|empty"];
    expect(pruneDismissedCorrupt(dismissed, [info("t_b", "empty")], { listTrusted: true })).toEqual([
      "t_b|empty",
    ]);
  });
});
