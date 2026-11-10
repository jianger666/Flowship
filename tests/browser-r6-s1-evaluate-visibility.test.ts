/**
 * R6-04：evaluate 批准之后的可见性与接管（electron-app/browser/evaluate-approval.mjs · runApprovedEvaluate 等）。
 *  - 每次执行写一条（脱敏、限长）AI 活动日志，带批准方式 + 表达式长度；
 *  - 用户接管中 → 不执行（USER_CONTROL）；执行中接管 → 被打断（USER_TOOK_OVER）；执行完才接管 → 丢弃结果；
 *  - `always` 不再写会话批准标记；总闸一旦关掉，下一次重新弹卡；revoke 路径可用；
 *  - settings_set 写入没生效 → 用户在活动日志里看得见（不静默）。
 * 会话用真 BrowserSession（接管 / inflight / 活动日志是真的），tab 用只有 evaluate 的假对象。
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEvaluateNotUserControlled,
  describeEvaluateForLog,
  ensureEvaluateApproval,
  isEvaluateApproved,
  revokeEvaluateApproval,
  runApprovedEvaluate,
} from "../electron-app/browser/evaluate-approval.mjs";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  vi.useRealTimers();
});

const abortable = (p: Promise<unknown>, signal?: AbortSignal): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });

interface HostLike {
  isEvaluateEnabled: () => boolean;
  emitEvent: (...a: unknown[]) => unknown;
}
const hostOf = (e: P4Env): HostLike => (e.session as unknown as { host: HostLike }).host;

const setup = async () => {
  const e = await makeP4Env();
  env = e;
  hostOf(e).isEvaluateEnabled = () => e.cfg.evaluateEnabled === true;
  const fakeTab = (evaluate: (x: string) => Promise<unknown>) => ({ id: "t1", url: "https://example.com/p", evaluate });
  const aiLines = () => e.activitySummaries();
  const ask = async (summary: string, action: "task" | "always" | "deny") => {
    const p = ensureEvaluateApproval(e.session as never, { summary, tabId: "t1", host: "example.com", alwaysVerifyMs: 20 });
    await e.settle();
    const list = e.session.prompts.list();
    expect(list).toHaveLength(1);
    e.session.prompts.answer(list[0].id, { action });
    return p;
  };
  return { e, fakeTab, aiLines, ask };
};

describe("R6-04 · 每次 evaluate 都写活动日志", () => {
  it("describeEvaluateForLog：批准方式 + 长度 + 先脱敏后截断（不含凭据，不含换行）", () => {
    const expr = `fetch("/x",{headers:{Authorization:"Bearer sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}})\n${"a".repeat(500)}`;
    const s = describeEvaluateForLog(expr, "prompt-task");
    expect(s).toContain("本次批准·仅本任务");
    expect(s).toContain(`共 ${expr.length} 字`);
    expect(s).not.toContain("sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(s).not.toContain("\n");
    expect(s.length).toBeLessThan(160); // 活动日志单条上限 160：长度信息不能被截掉
    expect(describeEvaluateForLog("1+1", "config")).toContain("免审批·总闸已开");
    expect(describeEvaluateForLog("1+1", "task")).toContain("本任务已批准");
    expect(describeEvaluateForLog("1+1", "prompt-always")).toContain("永久开启");
  });

  it("「仅本任务」批准后：第一次弹卡 + 记一条，第二次不弹卡但仍记一条（时间线上看得见）", async () => {
    const { e, fakeTab, aiLines, ask } = await setup();
    const run = vi.fn(async (x: string) => `r:${x}`);
    const tab = fakeTab(run);

    const first = await ask("document.title", "task");
    expect(first.via).toBe("prompt-task");
    await expect(runApprovedEvaluate(e.session as never, tab as never, { expression: "document.title", via: first.via, abortable })).resolves.toBe("r:document.title");

    const second = await ensureEvaluateApproval(e.session as never, { summary: "localStorage.length" });
    expect(second.via).toBe("task");
    expect(e.session.prompts.size()).toBe(0); // 第二次不再弹卡
    await runApprovedEvaluate(e.session as never, tab as never, { expression: "localStorage.length", via: second.via, abortable });

    const lines = aiLines().filter((s) => s.startsWith("执行了页面脚本"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("本次批准·仅本任务");
    expect(lines[0]).toContain("document.title");
    expect(lines[1]).toContain("本任务已批准");
    expect(lines[1]).toContain("localStorage.length");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("总闸开着免审批：同样每次记一条（免审批·总闸已开）", async () => {
    const { e, fakeTab, aiLines } = await setup();
    e.cfg.evaluateEnabled = true;
    const r = await ensureEvaluateApproval(e.session as never, { summary: "1+1" });
    expect(r.via).toBe("config");
    await runApprovedEvaluate(e.session as never, fakeTab(async () => 2) as never, { expression: "1+1", via: r.via, abortable });
    expect(aiLines().some((s) => s.includes("免审批·总闸已开") && s.includes("共 3 字"))).toBe(true);
  });
});

describe("R6-04 · 接管检查（执行前 / 中 / 后）", () => {
  it("用户接管中：弹卡前的检查和批准后的检查都拒绝（USER_CONTROL），脚本不执行、不记日志", async () => {
    const { e, fakeTab, aiLines } = await setup();
    e.session.takeover();
    expect(() => assertEvaluateNotUserControlled(e.session as never)).toThrowError(expect.objectContaining({ code: "USER_CONTROL" }));
    const run = vi.fn(async () => 1);
    await expect(runApprovedEvaluate(e.session as never, fakeTab(run) as never, { expression: "1", via: "task", abortable })).rejects.toMatchObject({ code: "USER_CONTROL" });
    expect(run).not.toHaveBeenCalled();
    expect(aiLines().some((s) => s.startsWith("执行了页面脚本"))).toBe(false);
  });

  it("批准期间用户接管：批准后的检查拒绝（卡片等待期间接管的竞态）", async () => {
    const { e, fakeTab, ask } = await setup();
    const p = ensureEvaluateApproval(e.session as never, { summary: "x", tabId: "t1" });
    await e.settle();
    e.session.takeover(); // 用户在卡片还开着时点了「接管」
    e.session.prompts.answer(e.session.prompts.list()[0].id, { action: "task" });
    const r = await p;
    const run = vi.fn(async () => 1);
    await expect(runApprovedEvaluate(e.session as never, fakeTab(run) as never, { expression: "x", via: r.via, abortable })).rejects.toMatchObject({ code: "USER_CONTROL" });
    expect(run).not.toHaveBeenCalled();
    void ask;
  });

  it("脚本执行中用户接管：被打断（USER_TOOK_OVER），inflight 已清理", async () => {
    const { e, fakeTab } = await setup();
    let release: (v: unknown) => void = () => {};
    const tab = fakeTab(() => new Promise((r) => (release = r)));
    const p = runApprovedEvaluate(e.session as never, tab as never, { expression: "longRunning()", via: "task", abortable });
    const settled = p.then(
      () => "ok",
      (err: { code?: string }) => err.code,
    );
    await e.settle();
    expect(e.session.inflight.size).toBe(1);
    e.session.takeover();
    await expect(settled).resolves.toBe("USER_TOOK_OVER");
    expect(e.session.inflight.size).toBe(0);
    release(1);
  });

  it("脚本恰好跑完、但此时用户已接管：结果丢弃（USER_TOOK_OVER），不把可能含用户输入的结果交给模型", async () => {
    const { e, fakeTab } = await setup();
    const tab = fakeTab(async () => {
      // 模拟「执行已完成，但接管发生在 abortable 之前」：直接改 controller（不走 abort）
      (e.session as unknown as { controller: string }).controller = "user";
      return "secret-typed-by-user";
    });
    await expect(runApprovedEvaluate(e.session as never, tab as never, { expression: "x", via: "task", abortable })).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
  });

  it("请求自身被取消（signal）：同样中止，不泄漏 inflight", async () => {
    const { e, fakeTab } = await setup();
    const ac = new AbortController();
    const tab = fakeTab(() => new Promise(() => {}));
    const p = runApprovedEvaluate(e.session as never, tab as never, { expression: "x", via: "task", signal: ac.signal, abortable });
    const settled = p.then(
      () => "ok",
      (err: { code?: string }) => err.code ?? "ERR",
    );
    await e.settle();
    ac.abort(Object.assign(new Error("c"), { code: "CANCELLED" }));
    await expect(settled).resolves.toBe("CANCELLED");
    expect(e.session.inflight.size).toBe(0);
  });
});

describe("R6-04 · always 的语义与撤销", () => {
  it("always 不写会话批准标记；总闸（实时）开着时免审批，关掉后下一次重新弹卡", async () => {
    const { e, ask } = await setup();
    const first = await ask("a", "always");
    expect(first.via).toBe("prompt-always");
    expect(isEvaluateApproved(e.session as never)).toBe(false);
    // settings_set 写回 → 主进程 onConfig 把总闸置 true（这里手动模拟）
    e.cfg.evaluateEnabled = true;
    await expect(ensureEvaluateApproval(e.session as never, { summary: "b" })).resolves.toEqual({ via: "config" });
    expect(e.session.prompts.size()).toBe(0);
    // 用户在设置里把总闸关掉：不再有任何残留的免审批
    e.cfg.evaluateEnabled = false;
    const p = ensureEvaluateApproval(e.session as never, { summary: "c", tabId: "t1" });
    await e.settle();
    expect(e.session.prompts.size()).toBe(1);
    e.session.prompts.answer(e.session.prompts.list()[0].id, { action: "deny" });
    await expect(p).rejects.toMatchObject({ code: "DENIED" });
  });

  it("revokeEvaluateApproval：撤销「仅本任务」批准 → 下一次重新弹卡；没批准过返回 false", async () => {
    const { e, ask } = await setup();
    expect(revokeEvaluateApproval(e.session as never)).toBe(false);
    await ask("a", "task");
    expect(isEvaluateApproved(e.session as never)).toBe(true);
    expect(revokeEvaluateApproval(e.session as never)).toBe(true);
    expect(isEvaluateApproved(e.session as never)).toBe(false);
    const p = ensureEvaluateApproval(e.session as never, { summary: "b", tabId: "t1" });
    await e.settle();
    expect(e.session.prompts.size()).toBe(1);
    e.session.prompts.answer(e.session.prompts.list()[0].id, { action: "deny" });
    await expect(p).rejects.toMatchObject({ code: "DENIED" });
  });
});

describe("R6-04 · settings_set 失败对用户可见（不静默）", () => {
  const systemLines = (e: P4Env) => (e.session.getState().recent as Array<{ actor: string; summary?: string }>).filter((x) => x.actor === "system").map((x) => x.summary ?? "");

  it("事件发不出去（emitEvent 返回 false）→ 立刻有系统活动日志提示，本次仍放行", async () => {
    const { e, ask } = await setup();
    hostOf(e).emitEvent = vi.fn(() => false);
    const r = await ask("x", "always");
    expect(r.via).toBe("prompt-always");
    expect(systemLines(e).some((s) => s.includes("没有保存成功"))).toBe(true);
  });

  it("事件发出了、但总闸始终没打开（server 写设置失败 / 被拒）→ 校验超时后有系统活动日志提示", async () => {
    const { e, ask } = await setup();
    hostOf(e).emitEvent = vi.fn(() => true);
    await ask("x", "always"); // alwaysVerifyMs = 20
    expect(systemLines(e).some((s) => s.includes("没有保存成功"))).toBe(false); // 校验窗口内先不报
    await new Promise((r) => setTimeout(r, 60));
    expect(systemLines(e).some((s) => s.includes("没有保存成功") && s.includes("手动开启"))).toBe(true);
  });

  it("事件发出且总闸在校验窗口内被置 true（写入成功）→ 不报警", async () => {
    const { e, ask } = await setup();
    hostOf(e).emitEvent = vi.fn(() => {
      setTimeout(() => (e.cfg.evaluateEnabled = true), 5);
      return true;
    });
    await ask("x", "always");
    await new Promise((r) => setTimeout(r, 60));
    expect(systemLines(e).some((s) => s.includes("没有保存成功"))).toBe(false);
  });
});

describe("R6-04 · index.mjs 接线（eslint 不扫 electron-app，未导入的标识符只会在真机上炸）", () => {
  it("index.mjs 从 evaluate-approval.mjs 导入了它用到的全部符号，且 opEvaluate / onConfig / ext 都接上了", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron-app", "browser", "index.mjs"), "utf8");
    const m = /import \{([^}]+)\} from "\.\/evaluate-approval\.mjs";/.exec(src);
    expect(m).not.toBeNull();
    const imported = (m?.[1] ?? "").split(",").map((s) => s.trim());
    for (const name of ["assertEvaluateNotUserControlled", "ensureEvaluateApproval", "revokeEvaluateApproval", "runApprovedEvaluate"]) {
      expect(imported, `缺少导入 ${name}`).toContain(name);
    }
    expect(src).toContain("runApprovedEvaluate(session, tab,");
    expect(src).toContain('extHandlers.set("evaluate.revoke"');
    expect(src).toMatch(/config\.evaluateEnabled === true && cfg\.evaluateEnabled === false/);
  });
});
