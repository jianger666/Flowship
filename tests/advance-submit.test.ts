/**
 * 推进弹窗提交结果的 UI 处置契约。
 *
 * 之前：失败一律「toast 只留首行 + 关弹窗 + 清预填」→ 指令 / 附图 / 深链预填全丢。
 * 现在：失败不关弹窗、不清预填，完整原因展示在弹窗里；成功才关 + 清。
 * UI 在 node 环境跑不起来：行为靠纯函数测，接线靠源码契约钉（参考 earlier-events-wiring-contract）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  advanceErrorMessage,
  planAdvanceUi,
  toastLine,
} from "../src/lib/advance-submit";

const MULTILINE =
  "wk-gate 未通过：\n- 缺少 REQ 目录\n- preflight 退出码 2\n下一步：先补文档仓";

describe("planAdvanceUi", () => {
  it("成功：关弹窗 + 清预填（深链预填只用一次），无错误无 toast", () => {
    expect(planAdvanceUi({ ok: true })).toEqual({
      closeDialog: true,
      clearPrefill: true,
      inlineError: null,
      toastError: null,
    });
  });

  it("失败：不关弹窗、不清预填，完整原因（多行原样）进 inlineError", () => {
    const ui = planAdvanceUi({ ok: false, error: new Error(MULTILINE) });
    expect(ui.closeDialog).toBe(false);
    expect(ui.clearPrefill).toBe(false);
    // 完整、不截断、换行保留
    expect(ui.inlineError).toBe(MULTILINE);
  });

  it("失败：toast 只留一句结论（首行），并指向弹窗里的完整原因", () => {
    const ui = planAdvanceUi({ ok: false, error: new Error(MULTILINE) });
    expect(ui.toastError).toBe("推进失败：wk-gate 未通过：（完整原因见弹窗）");
    // 单行原因不加后缀
    expect(
      planAdvanceUi({ ok: false, error: new Error("网络断了") }).toastError,
    ).toBe("推进失败：网络断了");
  });

  it("失败：非 Error 抛值也能转成文案；空文案有兜底（不会让弹窗里什么都不显示）", () => {
    expect(planAdvanceUi({ ok: false, error: "boom" }).inlineError).toBe("boom");
    const empty = planAdvanceUi({ ok: false, error: new Error("") });
    expect(empty.inlineError).toBeTruthy();
    expect(empty.closeDialog).toBe(false);
  });
});

describe("toastLine", () => {
  it("忽略后面全是空行的情况（不误加后缀）", () => {
    expect(toastLine("只有一行\n\n  \n")).toBe("只有一行");
  });
});

describe("advanceErrorMessage", () => {
  it("取服务端 { error: 字符串 }；缺失 / 类型不对回退 HTTP 状态", () => {
    expect(advanceErrorMessage({ error: "原因", code: "advance_failed" }, 400)).toBe(
      "原因",
    );
    expect(advanceErrorMessage({}, 502)).toBe("HTTP 502");
    expect(advanceErrorMessage({ error: { message: "x" } }, 500)).toBe("HTTP 500");
    expect(advanceErrorMessage({ error: "  " }, 400)).toBe("HTTP 400");
    expect(advanceErrorMessage(null, 503)).toBe("HTTP 503");
  });
});

// ---- 接线契约：页面失败分支不得再 setAdvanceDialogOpen(false) / 清预填 ----

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const page = readFileSync(
  path.join(srcDir, "app", "tasks", "[id]", "page.tsx"),
  "utf-8",
);
const dialog = readFileSync(
  path.join(srcDir, "components", "tasks", "advance-dialog.tsx"),
  "utf-8",
);
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 从 `marker` 起按花括号配对截出完整函数体（先跳过参数类型里的 `{}`，从第一个 `=>` 之后开始配） */
const sliceFunction = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的花括号没配平`);
};

describe("推进失败接线契约（page.tsx / advance-dialog.tsx）", () => {
  const code = stripComments(page);
  const body = sliceFunction(code, "const handleAdvance = async");
  const start = code.indexOf("const handleAdvance = async");
  const catchIdx = body.indexOf("} catch (err)");

  it("handleAdvance 失败分支经 planAdvanceUi 决定，且不无条件关弹窗 / 清预填", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(catchIdx).toBeGreaterThan(0);
    const catchBody = body.slice(catchIdx);
    expect(catchBody).toContain("planAdvanceUi({ ok: false");
    // 只允许 `if (ui.closeDialog) ...` / `if (ui.clearPrefill) ...` 这种由判定驱动的写法，禁止裸调
    const unguarded = catchBody
      .split("\n")
      .filter((l) => !/if \(ui\.(closeDialog|clearPrefill)\)/.test(l))
      .join("\n");
    expect(unguarded).not.toContain("setAdvanceDialogOpen(false)");
    expect(unguarded).not.toContain("setAdvancePrefill(null)");
    expect(catchBody).toContain("setAdvanceError(ui.inlineError)");
  });

  it("失败原因传进弹窗展示；弹窗渲染完整文案（保留换行、不截首行）", () => {
    expect(page).toContain("submitError={advanceError}");
    const dialogCode = stripComments(dialog);
    expect(dialogCode).toContain("submitError");
    expect(dialogCode).toMatch(/whitespace-pre-wrap[^"]*"[^>]*>\s*\{submitError\}/);
  });
});
