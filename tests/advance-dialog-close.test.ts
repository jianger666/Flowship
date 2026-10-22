/**
 * V6-03（第二轮 review）：推进提交中「取消」被禁用，但 Esc / X 仍能关弹窗，
 * 关闭即 rich.reset() 清掉指令 + 附件；失败时 toast 指向一个已不在的弹窗，再打开还挂陈旧错误条。
 *
 * 修法与 ShareToGroupDialog（`if (sharing) return`）同口径：提交中不可关。
 * 失败后弹窗本来就不关（planAdvanceUi 契约），所以「提交中不可关」就同时保住了失败态草稿——
 * rich.reset 只在 open 变 false 时跑，没有关闭就没有 reset。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAdvanceDialogOpenChange } from "@/lib/advance-dialog-close";

describe("resolveAdvanceDialogOpenChange", () => {
  it("提交中：任何关闭意图（Esc / X / 点外 / 取消）一律拦掉", () => {
    for (const reason of ["escape-key", "close-press", "outside-press", "focus-out", undefined]) {
      expect(
        resolveAdvanceDialogOpenChange({ next: false, reason, submitting: true, menuOpen: false }),
      ).toBe("block");
    }
  });

  it("提交中且菜单开着：也拦（菜单不可能在提交中开着，但守卫优先、不能被菜单分支绕过去）", () => {
    expect(
      resolveAdvanceDialogOpenChange({
        next: false,
        reason: "escape-key",
        submitting: true,
        menuOpen: true,
      }),
    ).toBe("block");
  });

  it("没在提交：slash / @ 菜单开着时的 Esc 归菜单（先关菜单、不关弹窗）", () => {
    expect(
      resolveAdvanceDialogOpenChange({
        next: false,
        reason: "escape-key",
        submitting: false,
        menuOpen: true,
      }),
    ).toBe("close-menu");
  });

  it("没在提交：菜单开着但不是 Esc（点 X）→ 正常关", () => {
    expect(
      resolveAdvanceDialogOpenChange({
        next: false,
        reason: "close-press",
        submitting: false,
        menuOpen: true,
      }),
    ).toBe("pass");
  });

  it("没在提交、没菜单：正常关", () => {
    expect(
      resolveAdvanceDialogOpenChange({
        next: false,
        reason: "escape-key",
        submitting: false,
        menuOpen: false,
      }),
    ).toBe("pass");
  });

  it("打开（next=true）永远放行，不受 submitting 影响", () => {
    expect(
      resolveAdvanceDialogOpenChange({ next: true, reason: undefined, submitting: true, menuOpen: false }),
    ).toBe("pass");
  });
});

// ---- 接线契约 ----
const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("advance-dialog 接线", () => {
  const src = stripComments(read("src/components/tasks/advance-dialog.tsx"));

  it("<Dialog onOpenChange> 先过 resolveAdvanceDialogOpenChange：block 直接 return，不碰菜单也不上抛", () => {
    const start = src.indexOf("<Dialog\n      open={open}");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("disablePointerDismissal", start));
    expect(block).toContain("resolveAdvanceDialogOpenChange({");
    expect(block).toMatch(/submitting,/);
    // 三个分支都有，且 block 在 close-menu 之前、onOpenChange(next) 之前
    const iBlock = block.indexOf('=== "block"');
    const iMenu = block.indexOf('=== "close-menu"');
    const iPass = block.indexOf("onOpenChange(next)");
    expect(iBlock).toBeGreaterThan(-1);
    expect(iMenu).toBeGreaterThan(iBlock);
    expect(iPass).toBeGreaterThan(iMenu);
    // 以前那句「只认菜单 Esc」的内联判断不能留着（会绕过 submitting 守卫）
    expect(block).not.toContain("details.reason === \"escape-key\" && menuOpenRef.current");
  });

  it("rich.reset 仍只挂在 open=false 的 effect 上（失败不关弹窗 → 失败态草稿不被 reset）", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) resetRich\(\);\s*\}, \[open\]\);/);
  });
});
