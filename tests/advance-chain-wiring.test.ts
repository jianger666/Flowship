/**
 * 自动推进的接线契约：
 *  - 人手推进清零自动推进计数、自动推进自己不清零（轮数上限能重新给额度的唯一入口）
 *  - 只有执行侧会带 viaAutoChain（别的调用方带了就等于绕过上限）
 *  - 提示词把「默认用户选、授权才自动」讲清，旧的「绝对不自动进入」措辞已撤
 *  - 工具注册 / 自有工具名单 / 非属主白名单三处一致
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  __resetAdvanceChainStateForTest,
  bumpAutoAdvanceSteps,
  getAutoAdvanceSteps,
} from "@/lib/server/advance-chain";
import { ADVANCE_STALE_MESSAGE } from "@/lib/server/advance-expectation";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-advance-wiring-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { advanceTask } = await import("@/lib/server/task-runner");

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
};

describe("advanceTask 对自动推进计数的影响（走真实 advanceTask，CAS 陈旧让它在任何副作用前就抛）", () => {
  const input = (viaAutoChain?: boolean) =>
    ({
      task: { id: "t_wiring" },
      actionType: "review",
      userInstruction: "",
      apiKey: "k",
      model: { id: "m" },
      // 任务不存在 → 盘上读不到 → 按「已变更」让位：排队后第一步就抛、不碰 worktree / agent
      expectedCurrentActionId: "a_nope",
      ...(viaAutoChain ? { viaAutoChain: true } : {}),
    }) as never;

  it("人手推进（没带 viaAutoChain）→ 计数清零，哪怕这次推进本身失败了", async () => {
    __resetAdvanceChainStateForTest();
    bumpAutoAdvanceSteps("t_wiring");
    bumpAutoAdvanceSteps("t_wiring");
    await expect(advanceTask(input())).rejects.toThrow(ADVANCE_STALE_MESSAGE);
    expect(getAutoAdvanceSteps("t_wiring")).toBe(0);
  });

  it("自动推进（viaAutoChain）→ 不清零", async () => {
    __resetAdvanceChainStateForTest();
    bumpAutoAdvanceSteps("t_wiring");
    bumpAutoAdvanceSteps("t_wiring");
    await expect(advanceTask(input(true))).rejects.toThrow(ADVANCE_STALE_MESSAGE);
    expect(getAutoAdvanceSteps("t_wiring")).toBe(2);
  });

  it("清零只清本任务", async () => {
    __resetAdvanceChainStateForTest();
    bumpAutoAdvanceSteps("t_wiring");
    bumpAutoAdvanceSteps("t_other");
    await expect(advanceTask(input())).rejects.toThrow();
    expect(getAutoAdvanceSteps("t_other")).toBe(1);
  });
});

describe("viaAutoChain 只有执行侧会带", () => {
  it("src 里 `viaAutoChain: true` 只出现在 advance-chain-runner.ts", () => {
    const hits = walk(path.join(ROOT, "src"))
      .filter((f) => /viaAutoChain\s*:\s*true/.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual(["src/lib/server/advance-chain-runner.ts"]);
  });

  it("advanceTask 里的清零在进串行队列之前、且受 viaAutoChain 守护", () => {
    const src = read("src/lib/server/task-runner.ts");
    const m = src.match(
      /export const advanceTask = async[\s\S]*?\n};\n/,
    );
    expect(m).not.toBeNull();
    const body = m![0];
    const reset = body.indexOf("resetAutoAdvanceSteps(");
    const queue = body.indexOf("runAdvanceExclusive(");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(queue);
    expect(body).toMatch(/if \(!input\.viaAutoChain\) resetAutoAdvanceSteps\(/);
  });
});

describe("提示词", () => {
  const superPrompt = read("prompts/_super.md");
  const build = read("prompts/action-build.md");
  const review = read("prompts/action-review.md");

  it("_super 教 advance_next：要原话、没说过就不用、登记≠现在做、有上限", () => {
    expect(superPrompt).toContain("**`advance_next`（按用户的话自动推进）**");
    expect(superPrompt).toContain("逐字引用");
    expect(superPrompt).toContain("用户没说过就不用");
    expect(superPrompt).toContain("登记 ≠ 现在去做下一步");
    expect(superPrompt).toContain("最多连续自动推进 3 步");
  });

  it("_super 教 [自动推进] 载荷怎么读：原话授权到哪就到哪", () => {
    expect(superPrompt).toContain("`[自动推进]` 开头的 `[NEXT_ACTION]`");
    expect(superPrompt).toContain("那句原话授权到哪就到哪");
  });

  it("旧措辞已撤：不再说「绝对不自动进入 / 自作主张…由用户在 UI 选」", () => {
    for (const src of [superPrompt, build, review]) {
      expect(src).not.toContain("绝对不自动进入");
    }
    expect(superPrompt).not.toContain("**下一 action 由用户选、不是你选**");
  });

  it("build / review：默认不自己进下一步，授权才走 advance_next，ship 类必须用户点名", () => {
    for (const src of [build, review]) {
      expect(src).toContain("`advance_next`");
      expect(src).toContain("不要自己进入下一 action");
      expect(src).toContain("点名");
    }
  });

  it("提示词里写的 advance_next 参数名与工具 schema 一致", async () => {
    const { flowShipTools } = await import("@/lib/server/flowship-tools");
    const tool = flowShipTools.find((t) => t.name === "advance_next")!;
    const props = Object.keys(
      (tool.parameters as { properties: Record<string, unknown> }).properties,
    );
    for (const name of ["task_id", "action", "user_words", "instruction", "custom_action_id", "dev_push_mode", "batch_ids"]) {
      expect(props).toContain(name);
    }
    for (const name of ["user_words", "instruction", "custom_action_id", "dev_push_mode"]) {
      expect(superPrompt).toContain(`\`${name}\``);
    }
  });
});

describe("工具注册三处一致", () => {
  it("flowShipTools 有它；自有工具名单认得它；非属主白名单没有它", async () => {
    const { flowShipTools } = await import("@/lib/server/flowship-tools");
    const { isFlowshipOwnToolName } = await import("@/lib/server/tool-result-persist");
    const { NON_OWNER_TURN_ALLOWED_TOOLS } = await import("@/lib/group-non-owner-prompt");
    expect(flowShipTools.map((t) => t.name)).toContain("advance_next");
    expect(isFlowshipOwnToolName("advance_next")).toBe(true);
    expect(isFlowshipOwnToolName("mcp:custom-user-tools:advance_next")).toBe(true);
    expect(NON_OWNER_TURN_ALLOWED_TOOLS).not.toContain("advance_next");
  });
});
