/**
 * 后台 shell 转圈的接线契约（源码级）
 *
 * 链路：sdk-message-handler（shell 成功返回 → 追踪）→ shell-background-tracker（读终端文件、落标记）
 *   → events.jsonl 里的 info 标记 → event-stream buildStreamItems（读未过滤事件 → 打 backgroundRunning）
 *   → tool-block 的 ToolBlockIcon（转圈）；收尾由 finalize-open-tools 补 ended。
 * 任何一环漏接都是静默失效——图标照旧亮「已完成」，而行为单测全绿。
 * React 渲染在 node 环境跑不起来（见 vitest.config.ts），所以靠源码契约守接线；行为本身的测试：
 *   tests/shell-background.test.ts           标记构造 / 解析 / 取最后一条 / 打标
 *   tests/shell-background-tracker.test.ts   终端文件认人 / 落 running·ended / 收手
 *   tests/shell-background-handler.test.ts   handleSdkMessage 到渲染管线的端到端
 *   tests/finalize-open-tools.test.ts        run 收尾补 ended、停追踪
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const toolBlock = read("components", "tasks", "event-stream", "tool-block.tsx");
const eventStream = read("components", "tasks", "event-stream.tsx");
const hidden = read("lib", "event-stream-hidden.ts");
const handler = read("lib", "server", "sdk-message-handler.ts");
const finalize = read("lib", "server", "finalize-open-tools.ts");

/** 取一个顶层 `const name = ...` 到下一个顶层声明之前的源码 */
const sliceFrom = (src: string, startMarker: string, endMarker: string): string => {
  const start = src.indexOf(startMarker);
  expect(start, `找不到 ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到 ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("tool-block：图标", () => {
  const icon = sliceFrom(toolBlock, "const ToolBlockIcon = (", "const formatDuration");

  it("backgroundRunning 与 running 同走转圈，且在完成态图标（终端 / 勾）之前判", () => {
    const spin = icon.indexOf('block.status === "running" || block.backgroundRunning');
    expect(spin).toBeGreaterThanOrEqual(0);
    expect(icon.indexOf("Loader2")).toBeGreaterThan(spin);
    // 转圈判断必须在 shell 的绿色终端图标之前，否则永远走不到
    expect(spin).toBeLessThan(icon.indexOf("<Terminal"));
    expect(spin).toBeLessThan(icon.indexOf("<Check"));
  });

  it("行右侧状态位带「后台运行中」", () => {
    expect(toolBlock).toMatch(
      /if \(block\.backgroundRunning\) statusBits\.push\("后台运行中"\)/,
    );
  });
});

describe("event-stream：buildStreamItems", () => {
  const fn = sliceFrom(eventStream, "const buildStreamItems = (", "/** 与 contentCount 同一计量");

  it("只在会话 running 时打标；读的是未过滤的 events（标记在 src 里已被藏掉）", () => {
    expect(fn).toMatch(/runActive\s*\?\s*markBackgroundRunningTools\(/);
    expect(fn).toContain("collectRunningBackgroundCallIds(events)");
    // 反例：从过滤后的 src 读会永远读不到标记
    expect(fn).not.toContain("collectRunningBackgroundCallIds(src)");
  });

  it("打标发生在 coerce 之后、分组之前（分组后的 work group 成员也带标）", () => {
    const coerce = fn.indexOf("coerceStaleRunningTools(merged)");
    const mark = fn.indexOf("markBackgroundRunningTools(");
    const group = fn.indexOf("groupChatRenderItems(");
    expect(coerce).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(coerce);
    expect(group).toBeGreaterThan(mark);
  });
});

describe("事件流不渲染标记", () => {
  it("event-stream-hidden 的单一闸里有标记分支", () => {
    expect(hidden).toMatch(/isShellBackgroundMarkerEvent\(ev\)\)\s*return true/);
  });
});

describe("sdk-message-handler：追踪入口", () => {
  const emit = sliceFrom(handler, "const emitToolResult = async (", "const maybeTrackBackgroundShell");
  const track = sliceFrom(
    handler,
    "const maybeTrackBackgroundShell = (",
    "// ----------------- assistant_delta 合帧",
  );

  it("只在非 muted 分支（真正广播的 tool_result）之后追踪，且在写事件之后（不拖慢结果落盘）", () => {
    const publish = emit.indexOf("await writeOwnedEventAndPublish(taskId, stillCurrent, event, origin)");
    const call = emit.indexOf("maybeTrackBackgroundShell(taskId, msg, meta, stillCurrent, origin)");
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(publish);
    // muted 分支（appendEvent）里不能有
    const mutedBranch = emit.slice(emit.indexOf("if (muted)"), emit.indexOf("} else {"));
    expect(mutedBranch).not.toContain("maybeTrackBackgroundShell");
  });

  it("只认 shell + success + exit 0 + 有命令；fire-and-forget（void）", () => {
    expect(track).toContain('msg.name !== "shell"');
    expect(track).toContain('meta.status !== "success"');
    expect(track).toMatch(/meta\.exitCode !== undefined && meta\.exitCode !== 0/);
    expect(track).toMatch(/if \(!command\) return/);
    expect(track).toMatch(/void trackBackgroundShell\(/);
  });

  it("开始时刻 = 结果到达时刻 − SDK 报告的 executionTime；lease / origin 透传", () => {
    expect(track).toContain("Date.now() - (meta.executionTime ?? 0)");
    expect(track).toMatch(/lease: stillCurrent/);
    expect(track).toMatch(/\borigin,/);
  });
});

describe("finalize-open-tools：收尾", () => {
  it("收尾先停追踪（await、等在途写盘落定）、**再**读事件尾巴，最后补 ended(run-ended)；失主不写", () => {
    const fn = sliceFrom(finalize, "export const finalizeOpenToolCalls = async (", "\n};\n");
    const stop = fn.indexOf("await stopBackgroundShellTracking(taskId)");
    const tail = fn.indexOf("await readEventsTail(taskId, FINALIZE_SCAN_TAIL)");
    expect(stop).toBeGreaterThanOrEqual(0);
    // 顺序是关键：先读尾巴再停的话，在途的 running 标记晚到落盘就成了永远没人补 ended 的孤儿
    expect(tail).toBeGreaterThan(stop);
    expect(finalize).toContain("await closeRunningBackgroundShells(taskId, lease, events)");
    const close = sliceFrom(finalize, "const closeRunningBackgroundShells = async (", "\n};\n");
    expect(close).toContain("if (!lease()) return");
    expect(close).toContain('reason: "run-ended"');
    // 带回旁路身份，补写的 ended 才会跟着 running 标记一起被折叠
    expect(close).toContain("shell.groupRun");
  });
});

describe("群答疑旁路 run：收尾点", () => {
  const rq = read("lib", "server", "restricted-question.ts");
  const side = sliceFrom(
    finalize,
    "export const finalizeSideRunBackgroundShells = async (",
    "\n};\n",
  );

  it("旁路 run 的 finally 里：注销之后 fire-and-forget 收自己起的后台 shell（origin = 本 run 的 runTag）", () => {
    const unregister = rq.indexOf("unregisterRestrictedQuestion(task.id, record);");
    const call = rq.indexOf("void finalizeSideRunBackgroundShells(task.id, origin, alive)");
    expect(unregister).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(unregister);
    expect(rq).toContain('import { finalizeSideRunBackgroundShells } from "./finalize-open-tools"');
  });

  it("只停 / 只收自己的 origin；停追踪在读尾巴之前；失主不写；整体 try/catch 不抛", () => {
    const stop = side.indexOf("await stopBackgroundShellTracking(taskId, origin)");
    const tail = side.indexOf("await readEventsTail(taskId, FINALIZE_SCAN_TAIL)");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(tail).toBeGreaterThan(stop);
    expect(side).toContain("shell.groupRun === origin");
    expect(side).toContain("if (!lease()) return");
    expect(side).toContain('reason: "run-ended"');
    expect(side).toMatch(/catch \(err\)/);
  });
});
