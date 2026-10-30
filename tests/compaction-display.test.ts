/**
 * 自定义 pi 压缩过程行：文案、插入位置、适配器接线
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPACTION_ABORTED_LABEL,
  COMPACTION_DONE_LABEL,
  COMPACTION_META_KIND,
  COMPACTION_RUNNING_LABEL,
  compactionEventMeta,
  compactionEventText,
  insertBeforeTrailingCompaction,
  isCompactionInfo,
  isCompactionRunning,
} from "@/lib/compaction-display";

const compaction = (id: string, status: "running" | "done") => ({
  kind: "info" as const,
  id,
  meta: { kind: COMPACTION_META_KIND, status },
});

describe("compaction-display", () => {
  it("start/end 文案一句、不写教程", () => {
    expect(compactionEventText({ start: true })).toBe(COMPACTION_RUNNING_LABEL);
    expect(compactionEventText({ start: false })).toBe(COMPACTION_DONE_LABEL);
    expect(compactionEventText({ start: false, aborted: true })).toBe(
      COMPACTION_ABORTED_LABEL,
    );
    expect(compactionEventMeta({ start: true, reason: "overflow" })).toEqual({
      kind: COMPACTION_META_KIND,
      status: "running",
      reason: "overflow",
    });
  });

  it("Cursor SDK 旧 sdk_summary 也当压缩完成行；running 只认 compaction", () => {
    expect(isCompactionInfo({ kind: "info", meta: { kind: "reconnecting" } })).toBe(
      false,
    );
    expect(isCompactionRunning(compaction("c1", "running"))).toBe(true);
    expect(isCompactionRunning(compaction("c1", "done"))).toBe(false);
    expect(
      isCompactionInfo({ kind: "info", meta: { kind: "sdk_summary" } }),
    ).toBe(true);
    expect(
      isCompactionRunning({ kind: "info", meta: { kind: "sdk_summary" } }),
    ).toBe(false);
  });

  it("流式气泡插到尾部连续 compaction 之前", () => {
    const streaming = { kind: "__streaming__", id: "__streaming__" };
    const items = [
      { kind: "assistant_message", id: "a" },
      compaction("c1", "running"),
    ];
    const next = insertBeforeTrailingCompaction(items, streaming);
    expect(next.map((it) => it.id)).toEqual(["a", "__streaming__", "c1"]);

    const withDone = insertBeforeTrailingCompaction(
      [...items, compaction("c2", "done")],
      streaming,
    );
    expect(withDone.map((it) => it.id)).toEqual([
      "a",
      "__streaming__",
      "c1",
      "c2",
    ]);

    const noTail = insertBeforeTrailingCompaction(
      [{ kind: "user_reply", id: "u" }],
      streaming,
    );
    expect(noTail.map((it) => it.id)).toEqual(["u", "__streaming__"]);
  });
});

describe("压缩接线契约", () => {
  const backend = readFileSync(
    path.resolve(import.meta.dirname, "../src/lib/server/custom-agent-backend.ts"),
    "utf-8",
  );
  const handler = readFileSync(
    path.resolve(import.meta.dirname, "../src/lib/server/sdk-message-handler.ts"),
    "utf-8",
  );
  const stream = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../src/components/tasks/event-stream.tsx",
    ),
    "utf-8",
  );
  const sdkSummary = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../src/lib/server/shell-output-bridge.ts",
    ),
    "utf-8",
  );

  it("pi 适配器接 compaction_start/end，不在 start 时 settle", () => {
    expect(backend).toMatch(/case "compaction_start"/);
    expect(backend).toMatch(/case "compaction_end"/);
    const startCase = backend.slice(
      backend.indexOf('case "compaction_start"'),
      backend.indexOf('case "compaction_end"'),
    );
    expect(startCase).not.toContain("this.settle(");
  });

  /**
   * 从某个顶层 `if (rawType === …)` 分支开头切到**下一个顶层分支**（下一个 `if (rawType ===` 或 `switch (msg.type)`）之前。
   * 以前直接切到 `switch (msg.type)`：compaction 分支后面又加了 auto_retry_start 分支（R14 Q11-02，它**要** flush），
   * 被一并切进「压缩分支」，就把「压缩不 flush」误判成红（R14 F5）。按「下一个顶层分支」切，中间再加别的分支也不会误伤。
   */
  const topBranchBlock = (marker: string): string => {
    const start = handler.indexOf(marker);
    expect(start, `handler 里找不到 ${marker}`).toBeGreaterThan(-1);
    const rest = handler.slice(start + marker.length);
    const next = rest.search(/\n {2}(?:if \(rawType ===|switch \(msg\.type\))/);
    expect(next, `${marker} 之后找不到下一个顶层分支`).toBeGreaterThan(-1);
    return handler.slice(start, start + marker.length + next);
  };

  it("handler 落 info 过程行，压缩分支不 flush 正文", () => {
    const block = topBranchBlock('rawType === "compaction_start"');
    expect(block).toContain("writeEv");
    expect(block).not.toContain("assistantCtx.flush");
    expect(block).toContain("willRetry");
  });

  it("handler 的自动重试分支与压缩相反：先 flush 思考和半截正文、复查 lease，再写一行说明（R14 Q11-02）", () => {
    const block = topBranchBlock('rawType === "auto_retry_start"');
    expect(block).toContain("flushThinkingBuffer");
    expect(block).toContain("assistantCtx.flush");
    // 认整句：flushThinkingBuffer 的参数里也有 stillCurrent 字样，只认单词会漏掉「flush 后不复查」
    expect(block).toContain("if (!stillCurrent()) return;");
    expect(block).toContain("writeEv");
    // 顺序：说明行必须落在半截正文之后，不然会排到半截前面
    expect(block.indexOf("flushThinkingBuffer")).toBeLessThan(
      block.indexOf("assistantCtx.flush"),
    );
    expect(block.indexOf("assistantCtx.flush")).toBeLessThan(
      block.indexOf("writeEv"),
    );
  });

  it("事件流把 streaming 插到尾部 compaction 之前，并用 CompactionRow", () => {
    // V1-01：事件流改走 composeStreamTail（flow → streaming → pending），它内部仍用 insertBeforeTrailingCompaction
    expect(stream).toContain("composeStreamTail");
    expect(
      readFileSync(
        path.resolve(import.meta.dirname, "../src/lib/stream-pending.ts"),
        "utf-8",
      ),
    ).toContain("insertBeforeTrailingCompaction");
    expect(stream).toContain("<CompactionRow");
  });

  it("Cursor SDK summary-started 落 compaction 过程行，不再等压完才出 info", () => {
    expect(sdkSummary).toContain('type === "summary-started"');
    expect(sdkSummary).toContain("compactionEventText({ start: true })");
    expect(sdkSummary).not.toContain("上下文过长，SDK 已自动压缩会话");
    expect(sdkSummary).not.toContain('kind: "sdk_summary"');
    expect(sdkSummary).not.toContain("maybePublishUsageDropCompaction");
  });
});
