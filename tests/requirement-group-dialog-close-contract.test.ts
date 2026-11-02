/**
 * 需求群弹窗：请求在途时 Esc / X / 取消不能被整个拦死（评审：请求挂住时只能等服务端超时）。
 * 在途状态住在组件里、不随弹窗卸载丢，所以放行关闭不会造成二次提交。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/components/tasks/requirement-group-dialog.tsx"),
  "utf8",
);

describe("RequirementGroupDialog 在途时可关闭", () => {
  it("close 不再因 busy 提前 return", () => {
    const start = src.indexOf("const close = useCallback(");
    const body = src.slice(start, src.indexOf("\n  );", start));
    expect(body).not.toContain("busy");
    expect(body).toContain("onOpenChange(next)");
  });
  it("取消按钮在途时不 disabled（文案改「关闭」）", () => {
    const m = /<Button type="button" variant="outline"([^>]*)onClick=\{\(\) => close\(false\)\}>/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("disabled");
  });
  it("防二次提交仍在：各 run* 入口自己带 busy 守卫，主按钮在途时 disabled", () => {
    expect(src).toMatch(/const runAuto = useCallback\(async \(\) => \{\s*if \(busy\) return;/);
    expect(src).toMatch(/const runBind = useCallback\(async \(\) => \{\s*if \(busy\) return;/);
    expect(src).toContain("disabled={busy || noStory}");
  });
});

// ---------- 会话守卫：卸载 invalidate + 失败分支同口径（第 5 轮 P3） ----------
//
// 没有 jsdom / 渲染器，组件的 effect 与回调没法真跑，这里用源码契约盯接线；
// 失败落地的纯逻辑（resolveFailureLanding）在 tests/generation-guard.test.ts 有行为测试。

/** `const <name> = useCallback(` 到它的依赖数组闭合（行首两格缩进的 `  }, [`）之间的文本 */
const callbackBody = (name: string): string => {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }, [", start);
  expect(end, `${name} 没有依赖数组`).toBeGreaterThan(start);
  return src.slice(start, end);
};

/** 去掉 `callee(` 开头、括号配平的整段调用（含参数里的回调体） */
const stripCalls = (text: string, callee: RegExp): string => {
  const re = new RegExp(callee.source, "g");
  let out = "";
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return out + text.slice(i);
    out += text.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < text.length && depth > 0) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") depth -= 1;
      j += 1;
    }
    i = j;
  }
};

/** 失败分支会写的「内联状态」setter（弹窗内容，属于发起请求的那一代） */
const INLINE_FAILURE_SETTER = /\b(setAutoError|setRebuild|setBindError|setFieldError|setBindBotLabel)\(/;
const FAILURE_LANDERS = /\b(landFailure|failAuto|failRebuild|failBind)\(/;

describe("RequirementGroupDialog 会话守卫：卸载时 invalidate", () => {
  it("守卫 effect 带 cleanup：return () => sessionGuard.invalidate()（卸载后在途请求落地全部丢弃）", () => {
    const m = /useEffect\(\(\) => \{\s*if \(open\) sessionGuard\.next\(\);[\s\S]*?\}, \[open, taskId, sessionGuard\]\);/.exec(src);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/else sessionGuard\.invalidate\(\);\s*return \(\) => sessionGuard\.invalidate\(\);/);
  });

  it("不引入重开回归：open 为 true 的重置 effect 仍在（rebuild / 输入 / 瞬时错误全清），关闭重开拿到的是干净状态", () => {
    const start = src.indexOf("if (!open) return;\n    setMode(\"auto\");");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("}, [open, loadStatus, resetTransient]);", start));
    expect(body).toContain("setRebuild(null);");
    expect(body).toContain("resetTransient();");
    expect(body).toContain("void loadStatus();");
  });
});

describe("RequirementGroupDialog 会话守卫：失败分支与成功分支同口径", () => {
  it("landFailure 经 resolveFailureLanding：同一代写内联、旧一代 toast 兜底（toastMessage 为 null 的引导静默丢弃）", () => {
    const body = callbackBody("landFailure");
    expect(body).toContain('resolveFailureLanding(sessionGuard, gen) === "inline"');
    expect(body).toContain("applyInline();");
    expect(body).toContain("else if (toastMessage) toast.error(toastMessage);");
    expect(src).toContain("resolveFailureLanding, resolveLanding");
  });

  it("runAuto / runRebuild / runBind：请求落地之后的失败分支不再直接写内联状态，全部经 landFailure（含 catch、needGroupRebuild、invalid_input、bot_not_in_group）", () => {
    const cases: Array<[string, string]> = [
      ["runAuto", "await ensureRequirementGroup(taskId);"],
      ["runRebuild", "await ensureRequirementGroup(taskId, { recreateFrom"],
      ["runBind", "await bindRequirementGroup(taskId, parsed);"],
    ];
    for (const [name, awaitMark] of cases) {
      const body = callbackBody(name);
      const at = body.indexOf(awaitMark);
      expect(at, `${name} 找不到请求调用 ${awaitMark}`).toBeGreaterThan(-1);
      const afterRequest = stripCalls(body.slice(at), FAILURE_LANDERS);
      expect(afterRequest, `${name} 请求落地后还有直接写内联状态的失败分支`).not.toMatch(INLINE_FAILURE_SETTER);
      // 真的走了 landFailure（而不是把 setter 删光）
      expect(body, name).toMatch(/landFailure\(gen,/);
    }
    // 失败 helper 的定义都落在 landFailure 上、并带发起时的 gen
    expect(callbackBody("runAuto")).toContain(
      "const failAuto = (message: string) => landFailure(gen, message, () => setAutoError(message));",
    );
    expect(callbackBody("runRebuild")).toMatch(/const failRebuild = \(message: string\) =>\s*landFailure\(gen, message, \(\) => \{\s*setAutoError\(message\);\s*setRebuild\(null\);/);
    expect(callbackBody("runBind")).toContain(
      "const failBind = (message: string) => landFailure(gen, message, () => setBindError(message));",
    );
    // needGroupRebuild 的引导：旧一代静默丢弃（toastMessage = null），只写发起它的那一代
    expect(callbackBody("runAuto")).toContain("landFailure(gen, null, () => setRebuild({ chatId, chatName }));");
  });

  it("gen 在任何 await confirm 之前取；confirm 之后若已换代就放弃（destructive 操作不替用户执行旧上下文）", () => {
    for (const [name, confirms] of [
      ["runRebuild", 1],
      ["runBind", 2],
      ["runClear", 1],
    ] as const) {
      const body = callbackBody(name);
      const genAt = body.indexOf("const gen = sessionGuard.current();");
      const firstConfirm = body.indexOf("await confirm(");
      expect(genAt, `${name} 没有取 gen`).toBeGreaterThan(-1);
      expect(firstConfirm, `${name} 没有 confirm`).toBeGreaterThan(-1);
      expect(genAt, `${name} 的 gen 必须在第一个 await confirm 之前取`).toBeLessThan(firstConfirm);
      expect(body.match(/const gen = sessionGuard\.current\(\);/g)?.length, `${name} 只能取一次 gen`).toBe(1);
      expect(
        body.match(/if \(!sessionGuard\.isCurrent\(gen\)\) return;/g)?.length,
        `${name} 每个 confirm 之后都要检查换代`,
      ).toBe(confirms);
    }
  });

  it("busy 标志不走守卫：autoBusy / bindBusy / clearing 由发起请求的 finally 无条件清（关掉再开仍转圈、不二次提交）", () => {
    expect(callbackBody("runAuto")).toMatch(/\} finally \{\s*setAutoBusy\(false\);\s*\}/);
    expect(callbackBody("runRebuild")).toMatch(/\} finally \{\s*setAutoBusy\(false\);\s*\}/);
    expect(callbackBody("runBind")).toMatch(/\} finally \{\s*setBindBusy\(false\);\s*\}/);
    expect(callbackBody("runClear")).toMatch(/\} finally \{\s*setClearing\(false\);\s*\}/);
  });

  it("成功分支口径不变：四个成功路径仍经 landSuccess(gen)；runClear 的失败本来就只 toast、没有内联状态可串", () => {
    expect(src.match(/landSuccess\(gen\)/g)?.length).toBe(4);
    const clear = callbackBody("runClear");
    expect(clear).toContain('toast.error(err instanceof Error ? `取消关联失败：${err.message}` : "取消关联失败");');
    expect(clear).not.toMatch(INLINE_FAILURE_SETTER);
  });
});
