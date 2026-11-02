/**
 * 全局 confirm / prompt 的「单槽」被顶替：前一个 Promise 必须用取消语义 resolve，不能永久 pending。
 * 纯逻辑在 lib/cancel-slot；use-dialog 的接线用源码契约钉住。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCancelSlot } from "@/lib/cancel-slot";

describe("createCancelSlot", () => {
  it("首次占位不触发任何取消", () => {
    const slot = createCancelSlot();
    let cancelled = 0;
    slot.take(() => {
      cancelled += 1;
    });
    expect(cancelled).toBe(0);
  });

  it("被顶替时：前一个占位的取消回调被调用一次、新的不动", () => {
    const slot = createCancelSlot();
    const calls: string[] = [];
    slot.take(() => calls.push("a"));
    slot.take(() => calls.push("b"));
    expect(calls).toEqual(["a"]);
    slot.take(() => calls.push("c"));
    expect(calls).toEqual(["a", "b"]);
  });

  it("正常结束（release）后再占位：不会去取消已完成的那个", () => {
    const slot = createCancelSlot();
    const calls: string[] = [];
    slot.take(() => calls.push("a"));
    slot.release();
    slot.take(() => calls.push("b"));
    expect(calls).toEqual([]);
  });

  it("flush：主动取消当前占位（卸载兜底），且只取消一次", () => {
    const slot = createCancelSlot();
    const calls: string[] = [];
    slot.take(() => calls.push("a"));
    slot.flush();
    slot.flush();
    expect(calls).toEqual(["a"]);
  });

  it("用法：被顶替的 confirm Promise 以 false resolve", async () => {
    const slot = createCancelSlot();
    const open = () =>
      new Promise<boolean>((resolve) => {
        slot.take(() => resolve(false));
      });
    const first = open();
    const second = open();
    await expect(first).resolves.toBe(false);
    // 第二个仍 pending：用 race 验证没被误取消
    const pending = Symbol("pending");
    await expect(Promise.race([second, Promise.resolve(pending)])).resolves.toBe(pending);
  });
});

describe("use-dialog 接线契约", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/hooks/use-dialog.tsx"),
    "utf8",
  );

  it("confirm / prompt 打开新弹窗前都先走 slot.take（顶替旧的）", () => {
    expect(src).toContain('from "@/lib/cancel-slot"');
    const confirmStart = src.indexOf("const confirm = useCallback(");
    const promptStart = src.indexOf("const prompt = useCallback(");
    expect(confirmStart).toBeGreaterThan(-1);
    expect(promptStart).toBeGreaterThan(confirmStart);
    const confirmBody = src.slice(confirmStart, promptStart);
    expect(confirmBody).toContain("slot.take(");
    expect(confirmBody).toMatch(/slot\.take\(\(\) => resolve\(null\)\)/);
    expect(confirmBody).toMatch(/slot\.take\(\(\) => resolve\(false\)\)/);
    const promptBody = src.slice(promptStart, src.indexOf("// 关 confirm", promptStart));
    expect(promptBody).toMatch(/slot\.take\(\(\) => resolve\(null\)\)/);
  });

  it("用户正常关闭（closeConfirm / closePrompt）后 release，卸载时 flush", () => {
    const confirmClose = src.slice(
      src.indexOf("const closeConfirm"),
      src.indexOf("const closePrompt"),
    );
    expect(confirmClose).toContain("slot.release()");
    const promptClose = src.slice(
      src.indexOf("const closePrompt"),
      src.indexOf("// prompt 当前校验错误"),
    );
    expect(promptClose).toContain("slot.release()");
    expect(src).toContain("slot.flush()");
  });
});
