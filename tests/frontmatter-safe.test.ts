/**
 * frontmatter 安全解析：`---js` / `---javascript` 前言不得 eval（gray-matter 默认引擎会）。
 * 另有契约：src 里除 frontmatter.ts 外，不得直接 import gray-matter。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseFrontmatter } from "@/lib/server/frontmatter";

// 触发即写 marker 文件：只要引擎被 eval，文件就会出现
const marker = path.join(
  os.tmpdir(),
  `flowship-fm-pwned-${process.pid}-${Date.now()}`,
);
const evilBlock = (lang: string): string =>
  `---${lang}\n(function(){ require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); return {}; })()\n---\nbody`;

afterEach(() => {
  rmSync(marker, { force: true });
});

describe("parseFrontmatter：正常 yaml / json 不受影响", () => {
  it("标准 yaml 前言 + 正文", () => {
    const r = parseFrontmatter("---\nname: foo\ndescription: bar\n---\n# 正文\n");
    expect(r.data).toEqual({ name: "foo", description: "bar" });
    expect(r.content.trim()).toBe("# 正文");
  });

  it("显式 yaml / yml / json 标记", () => {
    expect(parseFrontmatter("---yaml\na: 1\n---\nx").data).toEqual({ a: 1 });
    expect(parseFrontmatter("---yml\na: 1\n---\nx").data).toEqual({ a: 1 });
    expect(parseFrontmatter('---json\n{"a":1}\n---\nx').data).toEqual({ a: 1 });
    expect(parseFrontmatter("--- YAML \na: 1\n---\nx").data).toEqual({ a: 1 });
  });

  it("无前言：data 为空、content 原样", () => {
    const r = parseFrontmatter("# 只有正文\n");
    expect(r.data).toEqual({});
    expect(r.content).toBe("# 只有正文\n");
  });

  it("空串 / BOM 开头 / CRLF 都能解析", () => {
    expect(parseFrontmatter("").data).toEqual({});
    expect(parseFrontmatter("\uFEFF---\na: 1\n---\nx").data).toEqual({ a: 1 });
    expect(parseFrontmatter("---\r\na: 1\r\n---\r\nx").data).toEqual({ a: 1 });
  });
});

describe("parseFrontmatter：可执行引擎一律拒绝且无副作用", () => {
  it.each(["js", "javascript", "JS", "JavaScript", " js ", "coffee", "cson"])(
    "---%s 抛错、不 eval",
    (lang) => {
      expect(() => parseFrontmatter(evilBlock(lang))).toThrow();
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("BOM + ---js 同样拒绝", () => {
    expect(() => parseFrontmatter(`\uFEFF${evilBlock("js")}`)).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["constructor", "toString", "__proto__", "eval", "unknown-lang"])(
    "任意非白名单语言名 ---%s 抛错",
    (lang) => {
      expect(() => parseFrontmatter(`---${lang}\na: 1\n---\nx`)).toThrow();
    },
  );

  it("对照：不经 parseFrontmatter 直接用 gray-matter 默认引擎，确实会执行（证明测试有牙）", async () => {
    const { default: matter } = await import("gray-matter");
    // gray-matter 运行时有 clearCache，但类型声明里没有
    (matter as unknown as { clearCache: () => void }).clearCache();
    matter(evilBlock("js"));
    expect(existsSync(marker)).toBe(true);
  });
});

describe("契约：src / electron-app / scripts 内不得直接依赖 gray-matter", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const walk = (dir: string, out: string[]): string[] => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out; // 目录不存在（比如没有 scripts/）就当没有
    }
    for (const ent of ents) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, out);
      else if (/\.(ts|tsx|mjs|js|cjs)$/.test(ent.name)) out.push(abs);
    }
    return out;
  };

  // 只认真正的 import / require / 动态 import（注释里提到 gray-matter 不算）
  const importsGrayMatter =
    /(?:from\s+|require\(\s*|import\(\s*)["']gray-matter["']/;

  it("只有 frontmatter.ts 允许 import gray-matter", () => {
    const offenders = ["src", "electron-app", "scripts"]
      .flatMap((d) => walk(path.join(repoRoot, d), []))
      .filter((f) => !f.endsWith(path.join("lib", "server", "frontmatter.ts")))
      .filter((f) => importsGrayMatter.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});

describe("`----` 开头 = 没有 frontmatter（与 gray-matter 同口径，不抛错）", () => {
  it.each([
    ["----\nfoo", "----\nfoo"],
    ["-----", "-----"],
    ["----\n# 标题\n正文", "----\n# 标题\n正文"],
    ["\uFEFF----\nfoo", "----\nfoo"],
  ])("%j 不抛错、content 原样、data 为空", (raw, content) => {
    const r = parseFrontmatter(raw);
    expect(r.data).toEqual({});
    expect(r.content.replace(/^\uFEFF/, "")).toBe(content);
  });

  it("三个 `-` 后面跟非白名单语言仍然抛错（`---js` 不会被「4 个 -」的特判放过）", () => {
    expect(() => parseFrontmatter("---js\nx\n---\n")).toThrow();
    expect(() => parseFrontmatter("--- js\nx\n---\n")).toThrow();
  });
});
