/**
 * Q6-03：提交防双发——Enter 键路径的两道防线 + 提交 token 锁的**行为测试**。
 *
 * 背景：D7-03 让「提交在途编辑器仍可输入」之后，Enter 键路径的防双发只剩
 *   ① `ConversationComposer.handleSubmit` 对 submitting 的拦截（`composerSubmitBlock`）；
 *   ② `event-stream.submitVia` 的同步闩（`createSubmitLatch` / `startLatchedSubmit`）——
 *      React 的 `isSubmitting` 晚一帧才更新，同一帧连按两次 Enter 只有同步闩能拦；
 *   发送键 `disabled` 只防鼠标。第四轮复核：同时拆掉①②，27 个测试文件全绿（唯一的防线没人看着）。
 * 这里用真实纯函数 + 真实 `runOptimisticSubmit`（与 event-stream.submitVia 同接线）驱动「连按 Enter」序列。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldReleaseSubmitLock } from "@/lib/chat-submit-controller";
import { deriveComposeEnabled } from "@/lib/chat-pending-display";
import {
  composerSubmitBlock,
  createSubmitLatch,
  startLatchedSubmit,
} from "@/lib/composer-actions";
import { runOptimisticSubmit } from "@/lib/optimistic-submit";
import type { RichInputPayload } from "@/lib/rich-input-payload";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("composerSubmitBlock：Enter 与发送键共用的放行判据", () => {
  it("穷举 8 种组合：与旧内联判据 `disabled || submitting || !hasContent` 完全等价", () => {
    for (const disabled of [false, true]) {
      for (const submitting of [false, true]) {
        for (const hasContent of [false, true]) {
          const oldBlocked = disabled || submitting || !hasContent;
          const block = composerSubmitBlock({ disabled, submitting, hasContent });
          expect(block !== null).toBe(oldBlocked);
        }
      }
    }
  });

  it("原因分级：只有「有内容、没禁用、提交在途」才是 submitting（Q6-10 只对这一种给反馈）", () => {
    expect(composerSubmitBlock({ hasContent: true, submitting: true })).toBe("submitting");
    expect(composerSubmitBlock({ hasContent: false, submitting: true })).toBe("empty");
    expect(composerSubmitBlock({ hasContent: true, submitting: true, disabled: true })).toBe(
      "disabled",
    );
    expect(composerSubmitBlock({ hasContent: true, submitting: false })).toBeNull();
  });
});

describe("createSubmitLatch：同步闩", () => {
  it("占 → 再占失败 → 释放 → 又能占；释放幂等", () => {
    const l = createSubmitLatch();
    expect(l.held).toBe(false);
    expect(l.tryAcquire()).toBe(true);
    expect(l.held).toBe(true);
    expect(l.tryAcquire()).toBe(false);
    l.release();
    l.release();
    expect(l.held).toBe(false);
    expect(l.tryAcquire()).toBe(true);
  });

  it("两个闩互相独立（切 task 不串）", () => {
    const a = createSubmitLatch();
    const b = createSubmitLatch();
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
  });
});

describe("startLatchedSubmit：带闩的提交入口", () => {
  it("同一帧连调两次：run 只执行一次（第二次被闩拦下）；落定后才能再提交", async () => {
    const latch = createSubmitLatch();
    let runs = 0;
    let finish!: () => void;
    const run = () => {
      runs++;
      return new Promise<void>((r) => {
        finish = r;
      });
    };
    const args = { latch, hasSend: true, hasContent: true, run };
    expect(startLatchedSubmit(args)).toBe(true);
    expect(startLatchedSubmit(args)).toBe(false);
    expect(startLatchedSubmit(args)).toBe(false);
    expect(runs).toBe(1);
    finish();
    await tick();
    expect(latch.held).toBe(false);
    expect(startLatchedSubmit(args)).toBe(true);
    expect(runs).toBe(2);
  });

  it("失败（reject）也释放闩：一次网络错不会让输入框永远发不出去", async () => {
    const latch = createSubmitLatch();
    const args = {
      latch,
      hasSend: true,
      hasContent: true,
      run: () => Promise.reject(new Error("网络断了")),
    };
    expect(startLatchedSubmit(args)).toBe(true);
    await tick();
    expect(latch.held).toBe(false);
    expect(startLatchedSubmit(args)).toBe(true);
  });

  it("run 同步抛错：闩立刻释放并把错抛回去（不留死闩）", () => {
    const latch = createSubmitLatch();
    expect(() =>
      startLatchedSubmit({
        latch,
        hasSend: true,
        hasContent: true,
        run: () => {
          throw new Error("payload 快照炸了");
        },
      }),
    ).toThrow("payload 快照炸了");
    expect(latch.held).toBe(false);
  });

  it("没发送函数 / 没内容：不占闩、不执行（纯空消息不发，也不会把闩吃掉）", () => {
    const latch = createSubmitLatch();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve();
    };
    expect(startLatchedSubmit({ latch, hasSend: false, hasContent: true, run })).toBe(false);
    expect(startLatchedSubmit({ latch, hasSend: true, hasContent: false, run })).toBe(false);
    expect(runs).toBe(0);
    expect(latch.held).toBe(false);
  });
});

/** 与 event-stream.submitVia + ConversationComposer.handleSubmit 同接线的 chat 输入岛（真实纯函数 + 真实 runOptimisticSubmit） */
const makeChatComposer = (initialText: string) => {
  const st = {
    text: initialText,
    /** React state `isSubmitting`：晚一帧才变（flushFrame 才生效） */
    submitting: false,
    sends: [] as string[],
    restores: 0,
    resets: 0,
    hints: 0,
  };
  const latch = createSubmitLatch();
  let pendingSubmitting = false;
  let settle: Array<(ok: boolean) => void> = [];
  const payload = (): RichInputPayload => ({
    text: st.text,
    images: [],
    attachments: [],
    skillRefs: [],
  });
  const submitVia = () =>
    startLatchedSubmit({
      latch,
      hasSend: true,
      hasContent: st.text.trim().length > 0,
      run: () => {
        const snap = payload();
        pendingSubmitting = true;
        return runOptimisticSubmit({
          payload: snap,
          reset: () => {
            st.resets++;
            st.text = "";
          },
          restore: (p) => {
            st.restores++;
            st.text = p.text;
          },
          send: () =>
            new Promise<boolean>((resolve) => {
              st.sends.push(snap.text);
              settle.push((ok) => resolve(ok));
            }),
          isFailure: (r) => r === false,
        }).finally(() => {
          pendingSubmitting = false;
        });
      },
    });
  return {
    st,
    /** ConversationComposer.handleSubmit（Enter 与发送键点击同入口） */
    pressEnter: () => {
      const block = composerSubmitBlock({
        disabled: false,
        submitting: st.submitting,
        hasContent: st.text.trim().length > 0,
      });
      if (block === "submitting") st.hints++;
      if (block) return;
      submitVia();
    },
    /** 一帧过去：React state 追上同步状态 */
    flushFrame: () => {
      st.submitting = pendingSubmitting;
    },
    type: (t: string) => {
      st.text += t;
    },
    /** 服务端回包 */
    respond: async (ok: boolean) => {
      settle.shift()?.(ok);
      await tick();
    },
    latch,
    reset: () => {
      settle = [];
    },
  };
};

describe("连按 Enter 序列（真实闩 + 真实 runOptimisticSubmit）", () => {
  it("同一帧连按两次 Enter：React state 还没更新（submitting 仍 false），只有同步闩拦得住 → 只发一次", async () => {
    const c = makeChatComposer("你好");
    c.pressEnter();
    c.pressEnter(); // 此刻 st.submitting 还是 false（晚一帧）——handleSubmit 的守卫拦不住
    expect(c.st.sends).toEqual(["你好"]);
    expect(c.st.resets).toBe(1);
    await c.respond(true);
    expect(c.latch.held).toBe(false);
  });

  it("下一帧起（submitting 已为 true）：handleSubmit 守卫拦下，且给「正在发送…」反馈（Q6-10）；闩不参与", async () => {
    const c = makeChatComposer("第一句");
    c.pressEnter();
    c.flushFrame();
    expect(c.st.submitting).toBe(true);
    c.type("飞行中敲的第二句"); // 编辑器不锁（D7-03）
    c.pressEnter();
    c.pressEnter();
    expect(c.st.sends).toEqual(["第一句"]); // 没有双发
    expect(c.st.hints).toBe(2); // 两次被拦都给了反馈
    expect(c.st.text).toBe("飞行中敲的第二句"); // 新敲的内容没被吞
    await c.respond(true);
  });

  it("空输入（没内容）按 Enter：既不发也不提示「正在发送…」（没话要发就别打扰）", () => {
    const c = makeChatComposer("   ");
    c.flushFrame();
    c.pressEnter();
    expect(c.st.sends).toEqual([]);
    expect(c.st.hints).toBe(0);
  });

  it("失败恢复后可再次提交：失败 → 原文恢复 + 闩释放 → 再按 Enter 又能发；成功后同样", async () => {
    const c = makeChatComposer("重要的话");
    c.pressEnter();
    c.flushFrame();
    await c.respond(false); // 服务端失败
    c.flushFrame();
    expect(c.st.restores).toBe(1);
    expect(c.st.text).toBe("重要的话");
    expect(c.latch.held).toBe(false);
    expect(c.st.submitting).toBe(false);

    c.pressEnter(); // 重试
    expect(c.st.sends).toEqual(["重要的话", "重要的话"]);
    await c.respond(true);
    c.flushFrame();
    expect(c.st.text).toBe("");
    c.type("下一句");
    c.pressEnter();
    expect(c.st.sends).toEqual(["重要的话", "重要的话", "下一句"]);
    await c.respond(true);
  });

  it("随机序列（Enter / 敲字 / 一帧 / 回包成功或失败）：任一时刻在途发送 ≤ 1，且每个发出的字都最终要么送达要么回到输入框", async () => {
    let seed = 20260421;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 200; round++) {
      const c = makeChatComposer("起手");
      let inFlight = 0;
      let maxInFlight = 0;
      const delivered: string[] = [];
      const sentSnapshots: string[] = [];
      for (let step = 0; step < 40; step++) {
        const r = rnd();
        if (r < 0.35) {
          const before = c.st.sends.length;
          c.pressEnter();
          if (c.st.sends.length > before) {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            sentSnapshots.push(c.st.sends[c.st.sends.length - 1]!);
          }
        } else if (r < 0.55) c.type(`字${step}`);
        else if (r < 0.75) c.flushFrame();
        else if (inFlight > 0) {
          const ok = rnd() < 0.6;
          await c.respond(ok);
          inFlight--;
          if (ok) delivered.push(sentSnapshots.shift()!);
          else sentSnapshots.shift();
        }
      }
      expect(maxInFlight).toBeLessThanOrEqual(1);
      expect(c.st.sends.length).toBe(sentSnapshots.length + delivered.length + (c.st.restores));
    }
  });
});

describe("提交 token 锁：旧请求不得解开新请求的锁", () => {
  /** 与 chat-view.handleUserReply 同接线：submitTokenRef + finally 里 shouldReleaseSubmitLock */
  const makeLock = () => {
    let current: string | null = null;
    return {
      acquire: (t: string) => {
        current = t;
      },
      finish: (t: string): boolean => {
        if (shouldReleaseSubmitLock(current, t)) {
          current = null;
          return true;
        }
        return false;
      },
      get current() {
        return current;
      },
      /** 切 task：作废旧锁 */
      invalidate: () => {
        current = null;
      },
    };
  };

  it("A 在飞、B 起新锁；A 迟到收尾不得释放 B；B 收尾才释放", () => {
    const lock = makeLock();
    lock.acquire("tok_A");
    lock.acquire("tok_B"); // 切 task 后的新提交
    expect(lock.finish("tok_A")).toBe(false);
    expect(lock.current).toBe("tok_B");
    expect(lock.finish("tok_B")).toBe(true);
    expect(lock.current).toBeNull();
  });

  it("失败收尾后锁已空：下一次提交可以再拿锁；重复收尾无副作用", () => {
    const lock = makeLock();
    lock.acquire("tok_1");
    expect(lock.finish("tok_1")).toBe(true);
    expect(lock.finish("tok_1")).toBe(false); // 重复 finally 不会误解别人的锁
    lock.acquire("tok_2");
    expect(lock.current).toBe("tok_2");
    expect(lock.finish("tok_1")).toBe(false);
    expect(lock.current).toBe("tok_2");
  });

  it("切 task 作废旧锁后，旧请求收尾不会把 UI 锁状态误清（current 已空 → 不释放）", () => {
    const lock = makeLock();
    lock.acquire("tok_A");
    lock.invalidate();
    expect(lock.finish("tok_A")).toBe(false);
    lock.acquire("tok_B");
    expect(lock.finish("tok_A")).toBe(false);
    expect(lock.current).toBe("tok_B");
  });

  it("随机交错：只有「最后一次 acquire 的 token」收尾才能清锁", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 300; round++) {
      const lock = makeLock();
      let latest: string | null = null;
      const live: string[] = [];
      for (let i = 0; i < 30; i++) {
        if (rnd() < 0.45) {
          const t = `tok_${round}_${i}`;
          lock.acquire(t);
          latest = t;
          live.push(t);
        } else if (live.length > 0) {
          const t = live.splice(Math.floor(rnd() * live.length), 1)[0]!;
          const released = lock.finish(t);
          expect(released).toBe(t === latest);
          if (released) latest = null;
        }
        expect(lock.current).toBe(latest);
      }
    }
  });
});

describe("deriveComposeEnabled：提交在途编辑器不锁（防双发不靠锁编辑器，所以上面两道必须有测试）", () => {
  it("穷举：submitting=true 时恒可输入；其余按 awaitingUser / awaitingAsk / (running && 允许排队)", () => {
    for (const awaitingUser of [false, true])
      for (const awaitingAsk of [false, true])
        for (const isRunning of [false, true])
          for (const allowQueueWhileRunning of [false, true])
            for (const submitting of [false, true]) {
              const got = deriveComposeEnabled({
                awaitingUser,
                awaitingAsk,
                isRunning,
                allowQueueWhileRunning,
                submitting,
              });
              const want =
                awaitingUser || awaitingAsk || (isRunning && allowQueueWhileRunning) || submitting;
              expect(got).toBe(want);
              if (submitting) expect(got).toBe(true);
            }
  });
});

describe("接线（源码契约，仅钉位置——行为见上）", () => {
  const stream = source("src/components/tasks/event-stream.tsx");
  const composer = source("src/components/conversation-composer.tsx");
  const chatView = source("src/components/tasks/chat-view.tsx");

  it("event-stream.submitVia 走 startLatchedSubmit + 持久的 sendingLatch（不再是裸 ref 布尔）", () => {
    expect(stream).toContain("startLatchedSubmit({");
    expect(stream).toMatch(/latch:\s*sendingLatch/);
    expect(stream).toMatch(/useState\(createSubmitLatch\)/);
    expect(stream).not.toContain("sendingLockRef");
  });

  it("ConversationComposer：Enter（handleSubmit）与发送键 disabled 同用 composerSubmitBlock", () => {
    expect(composer).toMatch(/const block = composerSubmitBlock\(\{ disabled, submitting, hasContent \}\);/);
    expect(composer).toMatch(/disabled=\{composerSubmitBlock\(\{ disabled, submitting, hasContent \}\) !== null\}/);
    // 提交在途按 Enter 的反馈（Q6-10）：只在 block === "submitting" 时触发
    expect(composer).toMatch(/if \(block === "submitting"\) flashSendHint\(\);/);
    expect(composer).toContain("正在发送…");
  });

  it("失败恢复读的是 ref 里的最新路径 / 图片（不是渲染闭包里的陈旧值，R5-01）", () => {
    expect(stream).toContain("currentPaths: () => pathsRef.current,");
    expect(stream).toContain("currentImages: () => imagesRef.current,");
  });

  it("chat-view 的 finally 用 shouldReleaseSubmitLock 判 token", () => {
    expect(chatView).toMatch(
      /if \(shouldReleaseSubmitLock\(submitTokenRef\.current, submitToken\)\) \{/,
    );
  });
});
