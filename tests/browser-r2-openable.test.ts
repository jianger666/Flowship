/**
 * R2-11：csv 移出「打开」白名单后，渲染端（browser-user-logic.ts）与主进程（user-features.mjs）两侧的行为一致：
 * csv / tsv 只给「在文件夹中显示」，不给「打开」；其余文本类不受影响。
 * （白名单逐项相等 / 数量由 tests/browser-v4-ui.test.ts、tests/browser-v4-user-features.test.ts 钉。）
 */
import { describe, expect, it } from "vitest";

import { canOpenFile, OPENABLE_EXTENSIONS as MAIN_OPENABLE } from "../electron-app/browser/user-features.mjs";
import { canOpenDownload, canRevealDownload, OPENABLE_EXTENSIONS as UI_OPENABLE } from "@/components/browser/browser-user-logic";

const dl = (fileName: string) => ({ fileName, state: "completed" as const });

describe("R2-11：csv 不再给「打开」（两侧一致），仍给「在文件夹中显示」", () => {
  it("两侧白名单都没有 csv / tsv", () => {
    for (const e of ["csv", "tsv"]) {
      expect(UI_OPENABLE.has(e), `渲染端 ${e}`).toBe(false);
      expect(MAIN_OPENABLE.has(e), `主进程 ${e}`).toBe(false);
    }
  });

  it("渲染端 canOpenDownload 与主进程 canOpenFile 对 csv 类文件名（含大小写 / 尾点 / 伪装名）都是 false；揭示仍可用", () => {
    for (const n of ["data.csv", "DATA.CSV", "x.csv.", "x.csv ", "a.tsv", "a.pdf.csv"]) {
      expect(canOpenFile(n), `主进程 ${n}`).toBe(false);
      expect(canOpenDownload(dl(n)), `渲染端 ${n}`).toBe(false);
      expect(canRevealDownload(dl(n)), `${n} 仍可在文件夹中显示`).toBe(true);
    }
  });

  it("其余文本类不受影响（txt / json / md / log 仍可打开）", () => {
    for (const n of ["a.txt", "a.json", "a.md", "a.log"]) {
      expect(canOpenFile(n), `主进程 ${n}`).toBe(true);
      expect(canOpenDownload(dl(n)), `渲染端 ${n}`).toBe(true);
    }
  });
});
