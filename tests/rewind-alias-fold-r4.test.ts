/**
 * 第四轮 Q3-12：别名折叠比 APFS 窄（保护不足 7 对）。
 * 纯函数（所有平台）+「这块盘认为是同一个文件的，折叠键必须相同」的真实文件系统对拍（盘不折叠就自动没有断言）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildTargetFoldSet, foldRepoPath, isTargetTreeAlias } from "@/lib/server/rewind-target-alias";

const TMP = path.join(os.tmpdir(), `fe-fold-r4-${Date.now()}`);
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** 报告里 APFS 认为同一文件、旧折叠（仅小写）认不出的对子 */
const PAIRS: Array<[string, string]> = [
  ["ß.ts", "SS.ts"],
  ["ß.ts", "ss.ts"],
  ["ﬁle.ts", "file.ts"],
  ["ﬁle.ts", "FILE.ts"],
  ["ς.ts", "σ.ts"],
  ["ΑΣ.ts", "ασ.ts"],
  ["ßß.ts", "SSSS.ts"],
  // 第五轮复审：第四轮的单轮折叠把 ẞ（U+1E9E）弄坏了——它折成 ß 而 ß 自己折成 ss，两者在 APFS 上是同一个文件
  ["\u1E9E.ts", "\u00DF.ts"],
  ["\u1E9E.ts", "SS.ts"],
  // 多字符展开 + 组合标记：预组合 / 分解写法要同键
  ["\u0390.ts", "\u03AA\u0301.ts"],
  ["\u01F0.ts", "J\u030C.ts"],
];

describe("foldRepoPath：完整大小写折叠（Q3-12）", () => {
  it.each(PAIRS)("%s 与 %s 折叠成同一个键", (a, b) => {
    expect(foldRepoPath(`src/${a}`)).toBe(foldRepoPath(`src/${b}`));
    expect(isTargetTreeAlias(`src/${b}`, buildTargetFoldSet(`src/${a}\0`))).toBe(true);
  });

  it("旧口径不变：仅大小写 / 仅 NFC~NFD 不同仍折叠；真正不同的名字不误折叠", () => {
    expect(foldRepoPath("Components/Button.tsx")).toBe(foldRepoPath("components/button.TSX"));
    expect(foldRepoPath("caf\u00e9/a.ts")).toBe(foldRepoPath("cafe\u0301/a.ts"));
    expect(foldRepoPath("src/a.ts")).not.toBe(foldRepoPath("src/b.ts"));
    expect(foldRepoPath("straße.ts")).not.toBe(foldRepoPath("strase.ts"));
    expect(foldRepoPath("fi.ts")).not.toBe(foldRepoPath("f.ts"));
    // 键仍是小写（buildTargetFoldSet 的既有断言依赖这一点）
    expect([...buildTargetFoldSet("Components/a.ts\0README.md\0")].sort()).toEqual(["components/a.ts", "readme.md"]);
  });

  it("第五轮：折叠收敛（幂等）——fold(fold(x)) === fold(x)；单轮折叠在 ẞ 上不收敛", () => {
    const pool = ["a", "S", "s", "\u00DF", "\u1E9E", "\uFB01", "\u03C2", "\u03C3", "\u03A3", "\u0390", "\u03AA", "\u0301", "\u01F0", "J", "\u030C", "i", "I", "\u0130", "\u0131"];
    let seed = 20261021;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let n = 0; n < 4000; n++) {
      const len = 1 + Math.floor(rnd() * 6);
      let x = "";
      for (let i = 0; i < len; i++) x += pool[Math.floor(rnd() * pool.length)]!;
      const k = foldRepoPath(x);
      expect(foldRepoPath(k), JSON.stringify(x)).toBe(k);
      // 大小写 / 规范化改写不改变键（盘上互为同一文件的最基本形态）
      expect(foldRepoPath(x.toUpperCase()), `upper ${JSON.stringify(x)}`).toBe(k);
      expect(foldRepoPath(x.normalize("NFD")), `nfd ${JSON.stringify(x)}`).toBe(k);
    }
    // 单轮写法（第四轮）会让 ẞ 与 ß 键不同——这里直接把它当对照，证明上面的性质真能区分两种实现
    const single = (p: string): string => p.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
    expect(single("\u1E9E")).not.toBe(single("\u00DF"));
    expect(foldRepoPath("\u1E9E")).toBe(foldRepoPath("\u00DF"));
  });

  it("第六轮：末尾 NFC 不是冗余——输出必须是 NFC 形（去掉它会输出分解序列，且不再幂等）", () => {
    // 复审给的最小输入：ı + ΐ + ẞ + 两个组合重音。第二轮折叠展开 ΐ（→ ι + ̈ + ́）后若不再 NFC，键是分解形
    for (const x of ["\u0131\u0390", "\u0131\u0390\u1E9E\u0301\u0301", "\u0390", "\u01F0"]) {
      const k = foldRepoPath(x);
      expect(k, JSON.stringify(x)).toBe(k.normalize("NFC"));
      expect(foldRepoPath(k), JSON.stringify(x)).toBe(k);
    }
    // 无末尾 NFC 的对照实现：同一输入输出分解形、也不幂等——证明上面的断言真能区分两种实现
    const foldOnce = (p: string): string => p.normalize("NFC").toUpperCase().toLowerCase();
    const noFinalNfc = (p: string): string => foldOnce(foldOnce(p));
    expect(noFinalNfc("\u0131\u0390")).not.toBe(noFinalNfc("\u0131\u0390").normalize("NFC"));
    expect(noFinalNfc(noFinalNfc("\u0131\u0390\u1E9E\u0301\u0301"))).not.toBe(noFinalNfc("\u0131\u0390\u1E9E\u0301\u0301"));
  });

  it("第六轮：折叠内部的 NFC 也要有测试守护——希腊文下标 iota + 组合标记的 NFC / NFD 两种写法必须同键（去掉内部 NFC 会分叉）", () => {
    // `ᾀ` 系列（U+1F80…）+ 组合标记：toUpperCase 对「预组合」与「分解」写法展开不同，不先 NFC 就同一文件两个键
    const forms: string[] = [];
    for (const base of ["\u1F80", "\u1F81", "\u1F82", "\u1F83", "\u1FB3", "\u1F88"]) {
      for (const mark of ["\u0301", "\u0308", "\u0300"]) forms.push(base + mark);
    }
    for (const s of forms) {
      expect(foldRepoPath(s.normalize("NFC")), JSON.stringify(s)).toBe(foldRepoPath(s.normalize("NFD")));
    }
    // 对照：去掉所有内部 NFC 的实现会在这些输入上分叉（证明断言有区分力）
    const noInnerNfc = (p: string): string => p.toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
    expect(forms.some((s) => noInnerNfc(s.normalize("NFC")) !== noInnerNfc(s.normalize("NFD")))).toBe(true);
  });

  it("真实文件系统对拍：这块盘上互为同一文件的名字，折叠键必须相同（盘不折叠则无断言）", async () => {
    await fs.mkdir(TMP, { recursive: true });
    let sameOnDisk = 0;
    for (const [i, [a, b]] of PAIRS.entries()) {
      const dir = path.join(TMP, `p${i}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, a), "x\n");
      const sameFile = await fs.stat(path.join(dir, b)).then(() => true, () => false);
      if (sameFile) {
        sameOnDisk += 1;
        expect(foldRepoPath(a), `${a} ~ ${b} 在本盘是同一文件`).toBe(foldRepoPath(b));
      }
    }
    // 信息性：APFS 上应当 >0；Linux ext4 上为 0（无断言、不算失败）
    expect(sameOnDisk).toBeGreaterThanOrEqual(0);
  });
});
