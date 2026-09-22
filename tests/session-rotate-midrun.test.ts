/**
 * run 内水位触发器（2026-09-22 自动压缩续接）——注册表语义单测
 *
 * 消费点在 task-fs.recordTurnUsage（记账即探水位）；触发回调由 task-runner 的
 * consumeSessionRun 在 run.wait 前登记。这里锁：
 *   - 判定与 shouldRotateSession 双条件一致（水位超线 **并且** 堆过半）
 *   - 未登记 = no-op 不炸
 *   - 注销按 identity（并发 / 递归 consume 交错不误摘后继登记的那条）
 */
import { describe, expect, it } from "vitest";

import {
  maybeFireMidRunRotation,
  registerMidRunRotationTrigger,
  ROTATE_SESSION_INPUT_TOKENS,
  unregisterMidRunRotationTrigger,
} from "@/lib/server/session-rotate";

const overWater = { sessionInputTokens: ROTATE_SESSION_INPUT_TOKENS + 1 };

describe("maybeFireMidRunRotation", () => {
  it("水位到 + 堆过半 → 触发（重复 fire 去重由调用方 latch 负责）", () => {
    let fired = 0;
    const fn = () => {
      fired += 1;
    };
    registerMidRunRotationTrigger("t-fire", fn);
    maybeFireMidRunRotation("t-fire", overWater, 0.6);
    maybeFireMidRunRotation("t-fire", overWater, 0.6);
    expect(fired).toBe(2);
    unregisterMidRunRotationTrigger("t-fire", fn);
  });

  it("水位不到不触发", () => {
    let fired = 0;
    const fn = () => {
      fired += 1;
    };
    registerMidRunRotationTrigger("t-under", fn);
    maybeFireMidRunRotation("t-under", { sessionInputTokens: 100 }, 0.9);
    expect(fired).toBe(0);
    unregisterMidRunRotationTrigger("t-under", fn);
  });

  it("堆不吃紧不触发（防过矫双条件、与边界轮换一致）", () => {
    let fired = 0;
    const fn = () => {
      fired += 1;
    };
    registerMidRunRotationTrigger("t-heap", fn);
    maybeFireMidRunRotation("t-heap", overWater, 0.3);
    expect(fired).toBe(0);
    unregisterMidRunRotationTrigger("t-heap", fn);
  });

  it("未登记 = no-op 不炸", () => {
    expect(() =>
      maybeFireMidRunRotation("t-none", overWater, 0.9),
    ).not.toThrow();
  });

  it("注销按 identity：不误摘后继的登记", () => {
    let firedA = 0;
    const a = () => {
      firedA += 1;
    };
    const b = () => {
      /* 后继登记的另一条 */
    };
    registerMidRunRotationTrigger("t-id", a);
    // 不匹配的注销不该摘掉 a
    unregisterMidRunRotationTrigger("t-id", b);
    maybeFireMidRunRotation("t-id", overWater, 0.9);
    expect(firedA).toBe(1);
    // 摘掉自己登记的那条后不再触发
    unregisterMidRunRotationTrigger("t-id", a);
    maybeFireMidRunRotation("t-id", overWater, 0.9);
    expect(firedA).toBe(1);
  });
});
