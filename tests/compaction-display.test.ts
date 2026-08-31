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

  it("handler 落 info 过程行，压缩分支不 flush 正文", () => {
    const start = handler.indexOf('rawType === "compaction_start"');
    expect(start).toBeGreaterThan(-1);
    const block = handler.slice(start, handler.indexOf("switch (msg.type)", start));
    expect(block).toContain("writeEv");
    expect(block).not.toContain("assistantCtx.flush");
    expect(block).toContain("willRetry");
  });

  it("事件流把 streaming 插到尾部 compaction 之前，并用 CompactionRow", () => {
    expect(stream).toContain("insertBeforeTrailingCompaction");
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
