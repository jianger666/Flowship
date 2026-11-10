/**
 * 增强包 E2 · PromptHub（electron-app/browser/prompts.mjs，契约 §15.1）：
 * 登记 → 用户回答 / 超时 / 中止 / 销毁 → 一律按默认动作结束；上限；展示字段脱敏限长；凭据不落状态。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_PENDING_PROMPTS,
  PROMPT_ACTIONS,
  PROMPT_KIND_LIMITS,
  cleanPromptText,
  createPromptHub,
} from "../electron-app/browser/prompts.mjs";

const makeClock = () => {
  let nowVal = 1000;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => nowVal,
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { fn, at: nowVal + ms });
      return id;
    }) as never,
    clearTimeoutFn: ((id: number) => {
      timers.delete(id);
    }) as never,
    advance: (ms: number) => {
      const target = nowVal + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowVal = due[1].at;
        due[1].fn();
      }
      nowVal = target;
    },
    timers: () => timers.size,
  };
};

const setup = () => {
  const clock = makeClock();
  const onChange = vi.fn();
  const hub = createPromptHub({ now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, onChange });
  return { hub, clock, onChange };
};

describe("PromptHub", () => {
  it("每种提示的第一个动作是默认动作（超时 / 取消时用）：都是更安全的那个", () => {
    expect(PROMPT_ACTIONS.auth[0]).toBe("cancel");
    expect(PROMPT_ACTIONS.cert[0]).toBe("deny");
    expect(PROMPT_ACTIONS.permission[0]).toBe("deny");
    expect(PROMPT_ACTIONS.evaluate[0]).toBe("deny");
    expect(PROMPT_ACTIONS.clientcert[0]).toBe("decline");
  });

  it("request → list 展示字段；answer 把决定（含凭据）原样交给等待者，之后列表为空且凭据不留痕", async () => {
    const { hub, onChange } = setup();
    const p = hub.request({ kind: "auth", tabId: "t1", host: "intranet.example.com", detail: { realm: "Staging" } });
    const [info] = hub.list();
    expect(info).toMatchObject({ kind: "auth", tabId: "t1", host: "intranet.example.com", detail: { realm: "Staging" }, actions: ["cancel", "submit"] });
    expect(info.expiresAt - info.since).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(hub.answer(info.id, { action: "submit", username: "alice", password: "s3cret-pw" })).toBe(true);
    await expect(p).resolves.toEqual({ action: "submit", username: "alice", password: "s3cret-pw" });
    expect(hub.list()).toEqual([]);
    // 凭据不在展示列表 / hints 里的任何位置
    expect(JSON.stringify([hub.list(), hub.hints()])).not.toContain("s3cret-pw");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("展示给 UI 的 list 不含回答内容；登记时就不能把凭据塞进 detail 之外的字段", () => {
    const { hub } = setup();
    void hub.request({ kind: "auth", host: "a.com", detail: { realm: "r" } });
    const json = JSON.stringify(hub.list());
    expect(json).not.toMatch(/password|username/);
  });

  it("不在允许集合里的动作 / 未知 id / 形状错误 → false，提示保持挂起", async () => {
    const { hub } = setup();
    void hub.request({ kind: "cert", host: "bad.example" });
    const id = hub.list()[0].id;
    expect(hub.answer(id, { action: "submit" })).toBe(false);
    expect(hub.answer("nope", { action: "deny" })).toBe(false);
    expect(hub.answer(id, null as never)).toBe(false);
    expect(hub.answer(id, { action: 1 } as never)).toBe(false);
    expect(hub.size()).toBe(1);
  });

  it("超时按默认动作结束并标 timedOut；定时器被清掉", async () => {
    const { hub, clock } = setup();
    const p = hub.request({ kind: "permission", host: "a.com", timeoutMs: 5000 });
    clock.advance(4999);
    expect(hub.size()).toBe(1);
    clock.advance(1);
    await expect(p).resolves.toEqual({ action: "deny", timedOut: true });
    expect(hub.size()).toBe(0);
    expect(clock.timers()).toBe(0);
  });

  it("回答后定时器清掉，晚到的超时不会再结算第二次", async () => {
    const { hub, clock } = setup();
    const p = hub.request({ kind: "evaluate", timeoutMs: 1000 });
    expect(hub.answer(hub.list()[0].id, { action: "task" })).toBe(true);
    await expect(p).resolves.toEqual({ action: "task" });
    expect(clock.timers()).toBe(0);
    clock.advance(5000);
    expect(hub.size()).toBe(0);
  });

  it("signal 中止 → 默认动作 + cancelled；已中止的 signal 不进挂起表", async () => {
    const { hub } = setup();
    const ac = new AbortController();
    const p = hub.request({ kind: "auth", host: "a.com", signal: ac.signal });
    expect(hub.size()).toBe(1);
    ac.abort();
    await expect(p).resolves.toEqual({ action: "cancel", cancelled: true });
    expect(hub.size()).toBe(0);
    await expect(hub.request({ kind: "auth", signal: AbortSignal.abort() })).resolves.toEqual({ action: "cancel", cancelled: true });
    expect(hub.size()).toBe(0);
  });

  it(`R6-19：按 kind 分桶封顶（permission ≤ ${PROMPT_KIND_LIMITS.permission}）：超出的直接按默认动作结束，带 overflow（不是 timedOut，不会被误说成「无人处理」）`, async () => {
    const { hub } = setup();
    for (let i = 0; i < PROMPT_KIND_LIMITS.permission; i++) void hub.request({ kind: "permission", host: `h${i}.com` });
    expect(hub.size()).toBe(PROMPT_KIND_LIMITS.permission);
    const over = await hub.request({ kind: "permission", host: "overflow.com" });
    expect(over).toEqual({ action: "deny", overflow: true });
    expect(over).not.toHaveProperty("timedOut");
    expect(hub.size()).toBe(PROMPT_KIND_LIMITS.permission);
  });

  it("R6-19：页面刷满 permission 桶，不挤占 evaluate / auth / cert / clientcert 的保留位（审批流不被拒绝服务）", async () => {
    const { hub } = setup();
    for (let i = 0; i < 50; i++) void hub.request({ kind: "permission", host: `h${i}.com` });
    expect(hub.size()).toBe(PROMPT_KIND_LIMITS.permission);
    const settled: string[] = [];
    for (const kind of ["evaluate", "auth", "cert", "clientcert"] as const) {
      for (let i = 0; i < PROMPT_KIND_LIMITS[kind]; i++) {
        void hub.request({ kind, host: `${kind}${i}.com` }).then((r: { overflow?: boolean }) => r.overflow && settled.push(kind));
      }
    }
    await Promise.resolve();
    expect(settled).toEqual([]); // 各自的保留位里都挂上了，没有一个被 permission 挤成 overflow
    expect(hub.size()).toBe(MAX_PENDING_PROMPTS);
    expect(hub.list().filter((p: { kind: string }) => p.kind === "evaluate")).toHaveLength(PROMPT_KIND_LIMITS.evaluate);
    // 每个桶都满了：同 kind 再来一个才 overflow
    await expect(hub.request({ kind: "evaluate", host: "extra.com" })).resolves.toMatchObject({ action: "deny", overflow: true });
    // 回答 / 取消腾出名额后，同桶又能挂
    const first = hub.list().find((p: { kind: string }) => p.kind === "evaluate")!;
    expect(hub.cancel(first.id)).toBe(true);
    void hub.request({ kind: "evaluate", host: "again.com" });
    expect(hub.list().filter((p: { kind: string }) => p.kind === "evaluate")).toHaveLength(PROMPT_KIND_LIMITS.evaluate);
  });

  it("未知 kind → deny + cancelled；dispose 之后一律立即按默认动作结束", async () => {
    const { hub } = setup();
    await expect(hub.request({ kind: "bogus" as never })).resolves.toEqual({ action: "deny", cancelled: true });
    const p = hub.request({ kind: "cert", host: "x.com" });
    hub.dispose();
    await expect(p).resolves.toEqual({ action: "deny", cancelled: true });
    await expect(hub.request({ kind: "auth", host: "x" })).resolves.toEqual({ action: "cancel", cancelled: true });
    expect(hub.size()).toBe(0);
  });

  it("cancelWhere 只取消命中的（tab 关闭 / 导航离开时清理该 tab 的提示）；谓词抛错当没命中", async () => {
    const { hub } = setup();
    const a = hub.request({ kind: "auth", tabId: "t1", host: "a.com" });
    const b = hub.request({ kind: "auth", tabId: "t2", host: "b.com" });
    expect(hub.cancelWhere((p: { tabId?: string }) => p.tabId === "t1")).toBe(1);
    await expect(a).resolves.toEqual({ action: "cancel", cancelled: true });
    expect(hub.size()).toBe(1);
    expect(
      hub.cancelWhere(() => {
        throw new Error("boom");
      }),
    ).toBe(0);
    expect(hub.cancel(hub.list()[0].id)).toBe(true);
    await expect(b).resolves.toEqual({ action: "cancel", cancelled: true });
  });

  it("validate 对回答 payload 做校验 / 规整；抛错 = 回答无效、提示保持挂起", async () => {
    const { hub } = setup();
    const p = hub.request({
      kind: "auth",
      host: "a.com",
      validate: (d: { username?: unknown; password?: unknown }) => {
        if (typeof d.username !== "string" || d.username.length > 8) throw new Error("bad");
        return { username: d.username, password: String(d.password ?? "") };
      },
    });
    const id = hub.list()[0].id;
    expect(hub.answer(id, { action: "submit", username: "x".repeat(20) })).toBe(false);
    expect(hub.size()).toBe(1);
    expect(hub.answer(id, { action: "submit", username: "bob", password: 5, extra: "dropped" })).toBe(true);
    await expect(p).resolves.toEqual({ action: "submit", username: "bob", password: "5" });
  });

  it("host / detail 来自页面或网络：剥格式字符（零宽 / RTL）、折叠空白、限长、限键数", () => {
    const { hub } = setup();
    void hub.request({
      kind: "cert",
      host: "evil\u202E.example\u200B.com",
      detail: Object.fromEntries([
        ["error", "ERR_CERT\n_AUTHORITY\u3164_INVALID"],
        ["subject", "A".repeat(500)],
        ...Array.from({ length: 30 }, (_, i) => [`k${i}`, "v"]),
      ]),
    });
    const [info] = hub.list();
    expect(info.host).toBe("evil.example.com");
    expect(info.detail.error).toBe("ERR_CERT _AUTHORITY_INVALID");
    expect(info.detail.subject.length).toBeLessThanOrEqual(201);
    expect(Object.keys(info.detail).length).toBeLessThanOrEqual(12);
    expect(cleanPromptText("a\u202Eb", 10)).toBe("ab");
  });

  it("hints 只给 id / kind / host / tabId（给 AI 写「已请用户处理」用，不含 detail）", () => {
    const { hub } = setup();
    void hub.request({ kind: "auth", tabId: "t1", host: "a.com", detail: { realm: "secret-realm" } });
    void hub.request({ kind: "cert", host: "b.com" });
    expect(hub.hints("auth")).toEqual([{ id: "p1", kind: "auth", host: "a.com", tabId: "t1" }]);
    expect(hub.hints().length).toBe(2);
    expect(JSON.stringify(hub.hints())).not.toContain("secret-realm");
  });

  it("list 返回的是拷贝：外部改它不影响内部登记", () => {
    const { hub } = setup();
    void hub.request({ kind: "permission", host: "a.com", detail: { permission: "geolocation" } });
    const l = hub.list();
    l[0].detail.permission = "hacked";
    l[0].actions.push("allow-forever");
    expect(hub.list()[0].detail.permission).toBe("geolocation");
    expect(hub.list()[0].actions).toEqual(["deny", "allow", "allow-session"]);
  });
});
