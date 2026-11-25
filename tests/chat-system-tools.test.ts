/**
 * chat（自由对话）会话的系统工具清单：只挂 chat 用得上的，不挂 task / action 容器专用的 5 个。
 *
 * 钉三层：
 * 1. 清单对账：「挂」+「不挂」恰好覆盖 `flowShipTools` 全集、互不重叠——新增系统工具必须显式归类，否则这里红；
 * 2. 两条后端（Cursor `buildSdkCustomTools` / pi `buildCustomTools`）按这份清单收窄后，挂出来的系统工具恰好就是它；
 * 3. 接线：chat-runner 的 `Agent.create` / `Agent.resume` 两处都传了清单（resume 按本轮入参重建工具、不沿用上次的清单，
 *    漏一处，重连 / 重启恢复后的会话会悄悄回到「系统工具全挂」）。
 *
 * 另有两条「别顺手改」的理由：
 * - `submit_mr` 必须保留：用户的 release-review skill 在 chat 里直接建上线 MR；
 * - `advance_next` 在 chat 里本来就被拒（flowship-tools 里 `task.mode === "chat"` 直接 fail）——挂着是纯白付。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readSource } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-system-tools-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { CHAT_OMITTED_SYSTEM_TOOL_NAMES, CHAT_SYSTEM_TOOL_NAMES } = await import("@/lib/server/chat-system-tools");
const { buildSdkCustomTools, flowShipTools } = await import("@/lib/server/flowship-tools");
const { __buildCustomToolsForTest } = await import("@/lib/server/custom-agent-backend");

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const ALL = flowShipTools.map((t) => t.name);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
/** 只看 Flowship 系统工具（浏览器 / 子代理 / 编码工具另算，不受 systemToolNames 影响） */
const sysOnly = (names: readonly string[]): string[] => names.filter((n) => ALL.includes(n));

describe("清单对账", () => {
  it("「挂」+「不挂」恰好覆盖 flowShipTools 全集，互不重叠（新增系统工具必须显式归类）", () => {
    expect(sorted([...CHAT_SYSTEM_TOOL_NAMES, ...CHAT_OMITTED_SYSTEM_TOOL_NAMES])).toEqual(sorted(ALL));
    for (const n of CHAT_OMITTED_SYSTEM_TOOL_NAMES) expect(CHAT_SYSTEM_TOOL_NAMES, n).not.toContain(n);
  });

  it("不挂的就是 task / action 容器专用的 5 个", () => {
    expect(sorted(CHAT_OMITTED_SYSTEM_TOOL_NAMES)).toEqual([
      "advance_next",
      "notify_group_testers",
      "set_feishu_testers",
      "set_plan_batches",
      "submit_work",
    ]);
  });

  it("submit_mr 必须保留（release-review skill 在 chat 里建上线 MR）；ask_user / create_custom_action 同样要在", () => {
    for (const n of ["submit_mr", "ask_user", "create_custom_action"]) {
      expect(CHAT_SYSTEM_TOOL_NAMES, n).toContain(n);
    }
  });
});

describe("两条后端按清单收窄", () => {
  it("Cursor：不传 = 系统工具全挂；传 chat 清单 = 系统工具恰好是它", () => {
    const full = Object.keys(buildSdkCustomTools("tok", { taskId: "tA" }));
    expect(sorted(sysOnly(full))).toEqual(sorted(ALL));

    const narrow = Object.keys(buildSdkCustomTools("tok", { taskId: "tA", systemToolNames: CHAT_SYSTEM_TOOL_NAMES }));
    expect(sorted(sysOnly(narrow))).toEqual(sorted(CHAT_SYSTEM_TOOL_NAMES));
    for (const n of CHAT_OMITTED_SYSTEM_TOOL_NAMES) expect(narrow, n).not.toContain(n);
  });

  it("pi：同一份清单，系统工具恰好是它", () => {
    const names = (
      __buildCustomToolsForTest(
        "tok",
        TMP_ROOT,
        { input: { systemToolNames: CHAT_SYSTEM_TOOL_NAMES } } as never,
        [],
        "tB",
      ) as unknown as Array<{ name: string }>
    ).map((d) => d.name);
    expect(sorted(sysOnly(names))).toEqual(sorted(CHAT_SYSTEM_TOOL_NAMES));
    for (const n of CHAT_OMITTED_SYSTEM_TOOL_NAMES) expect(names, n).not.toContain(n);
  });
});

describe("接线：chat-runner 的 create / resume 两处都传清单", () => {
  const src = readSource("src/lib/server/chat-runner.ts");
  /** 取调用起点往后一段（已去注释的源码）；create / resume 的入参各约 30 行，1200 字符足够、又不会跨到另一处调用 */
  const windowAfter = (re: RegExp, span = 1200): string => {
    const idx = src.search(re);
    expect(idx, String(re)).toBeGreaterThanOrEqual(0);
    return src.slice(idx, idx + span);
  };

  it("import 自 chat-system-tools", () => {
    expect(src).toMatch(/import \{ CHAT_SYSTEM_TOOL_NAMES \} from "\.\/chat-system-tools";/);
  });

  it("Agent.create 传了 systemToolNames: CHAT_SYSTEM_TOOL_NAMES", () => {
    expect(windowAfter(/Agent\.create\(\{/)).toMatch(/systemToolNames:\s*CHAT_SYSTEM_TOOL_NAMES/);
  });

  it("Agent.resume 传了 systemToolNames: CHAT_SYSTEM_TOOL_NAMES", () => {
    expect(windowAfter(/Agent\.resume\(task\.sessionAgentId,\s*\{/)).toMatch(
      /systemToolNames:\s*CHAT_SYSTEM_TOOL_NAMES/,
    );
  });
});
