/**
 * 第二轮 review §5「注释与实现不符」+ V12-04 文案 + V11-02：task 详情页 / MCP 弹窗的注释纠错与文案。
 *
 * 注释纠错本身没法「行为测试」，这里钉的是：错误说法不能回来、正确事实有迹可循。
 * 事实依据（读码确认）：
 *  - 收尾旁白期间 runStatus 保持 running：task-runner.ts runActionPostCheck 的 `wrapUpStillGoing`；
 *  - BatchProgress 没拆批次时 `return null`（batch-progress.tsx）；
 *  - MCP 开关只写 task.disabledMcpServers，agent 的 MCP 在 buildMergedMcpForTask 里随「新起 / 恢复」会话时读取，
 *    task 模式没有「改了就懒重启」那一套（chat 才有，见 chat-inject 的 mcpUnchanged）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatFinalizeNotice } from "@/lib/task-event-text";
import { mcpEffectNote } from "@/lib/mcp-effect-note";

const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");

const pageRaw = read("src/app/tasks/[id]/page.tsx");
const mcpRaw = read("src/components/tasks/task-mcp-panel.tsx");

describe("V12-04：终结确认文案不写死分支名（与 formatFinalizeNotice 同口径）", () => {
  it("page.tsx 里不再出现「合入 main」", () => {
    expect(pageRaw).not.toMatch(/合入\s*main/);
  });

  it("确认文案的措辞与事件流那句「任务已标记为已合入」一致：写「已合入」+ MR 已合并，不夹分支名", () => {
    expect(formatFinalizeNotice("merged")).toBe("任务已标记为已合入");
    expect(pageRaw).toContain("标记本任务已合入（对应 MR 已合并）、agent 收尾结束 run");
  });
});

describe("V9-03 过期注释：服务端已让收尾旁白期间保持 running", () => {
  it("runActive latch 的注释不再声称「runStatus 交卷后会 running → awaiting_ack」，并指向 wrapUpStillGoing", () => {
    expect(pageRaw).not.toContain("runStatus 交卷后会 running → awaiting_ack");
    expect(pageRaw).toContain("wrapUpStillGoing");
  });
});

describe("page.tsx 分批 chip 注释与实现一致", () => {
  it("没拆批次时 BatchProgress 不渲染（注释不能再写「灰色未分批」）", () => {
    expect(pageRaw).not.toContain("没拆=灰色「未分批」");
    expect(pageRaw).toMatch(/没拆=不渲染/);
    // 实现事实：batch-progress.tsx 在没拆批次时直接 return null
    expect(read("src/components/tasks/batch-progress.tsx")).toMatch(/if \(!hasBatches\) return null;/);
  });
});

describe("task-mcp-panel：头部注释与实现一致 + V11-02 何时生效说明", () => {
  it("文件头不再承诺从未存在的「下次启动 / revise 时生效」底部提示；按钮写法与实现一致（MCP + 计数徽标）", () => {
    expect(mcpRaw).not.toContain("revise 时生效");
    expect(mcpRaw).not.toContain("MCP servers (3/4)");
  });

  it("弹窗里真的渲染了「何时生效」说明，且随 runStatus 区分运行中", () => {
    expect(mcpRaw).toContain('import { mcpEffectNote } from "@/lib/mcp-effect-note"');
    expect(mcpRaw).toContain("mcpEffectNote(task.runStatus)");
  });

  it("运行中：明说「正在跑的 agent 不会热更新」「这次改动对它无效」，并给出何时生效", () => {
    const n = mcpEffectNote("running");
    expect(n).toContain("AI 正在运行");
    expect(n).toContain("不会热更新");
    expect(n).toContain("下次推进新起 agent");
    expect(n).not.toContain("revise");
  });

  it("没在运行：同样说明何时生效，但不再冒充「正在运行」", () => {
    for (const s of ["idle", "awaiting_user", "error"] as const) {
      const n = mcpEffectNote(s);
      expect(n).not.toContain("AI 正在运行");
      expect(n).toContain("不会热更新");
      expect(n).toContain("下次推进新起 agent");
    }
  });

  it("两种文案都点出「续用当前 agent」不会换——这是推进弹窗里真实存在的开关", () => {
    expect(mcpEffectNote("running")).toContain("续用当前 agent");
    expect(mcpEffectNote("idle")).toContain("续用当前 agent");
    expect(read("src/components/tasks/advance-dialog.tsx")).toContain("续用当前");
  });
});
