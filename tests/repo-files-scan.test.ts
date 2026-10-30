/**
 * 仓库文件索引里「不依赖 git」的部分（R14 B6-5 / Q21-01）：
 *  - `entriesFromPaths`：git 清单 → 索引条目的纯函数（去重 / 嵌套仓库项 / denylist 过滤 / 补祖先 / 截断）；
 *  - `scanRepoRoot`：目录遍历——git 不通时的退路。浅层优先（BFS），额度用完丢最深的、带 `truncated`；
 *  - denylist 名单本身：钉死。名单一增一减，菜单里能看到什么就变了，必须有人同步改这里。
 *
 * 为什么要浅层优先：改前是深度优先，字母序排在 `src` 前面的大目录（`.nuxt/`、`DerivedData/`）把 2 万额度吃光，
 * `src/` 一条都收不到。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { REPO_FILES_MAX_ENTRIES } from "@/lib/repo-files-shared";
import { entriesFromPaths, REPO_SCAN_IGNORE_DIRS, scanRepoRoot } from "@/lib/server/repo-files";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-repo-files-scan-")));
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
const mkRoot = (): string => {
  const root = path.join(TMP, `root-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
};
const put = (root: string, rel: string): void => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
};
const paths = (r: { entries: Array<{ path: string }> }): string[] => r.entries.map((e) => e.path);

// ---------------------------------------------------------------------- entriesFromPaths

describe("entriesFromPaths：git 清单 → 索引条目", () => {
  it("补祖先目录：git 只给文件，菜单里目录也要能 @；目录带尾 /，isDir 对得上", () => {
    expect(entriesFromPaths(["a/b/c.ts"])).toEqual({
      entries: [
        { path: "a/", isDir: true },
        { path: "a/b/", isDir: true },
        { path: "a/b/c.ts", isDir: false },
      ],
      truncated: false,
    });
  });

  it("去重：同一路径出现多次（合并冲突态下 git 会这样）只留一条；共用的祖先也只补一次", () => {
    expect(paths(entriesFromPaths(["a/x.ts", "a/x.ts", "a/y.ts"]))).toEqual(["a/", "a/x.ts", "a/y.ts"]);
  });

  it("以 / 结尾的项是未跟踪的嵌套仓库：当目录收，不展开", () => {
    expect(entriesFromPaths(["nested/", "pkg/inner/", "src/App.tsx"]).entries).toEqual([
      { path: "nested/", isDir: true },
      { path: "pkg/", isDir: true },
      { path: "pkg/inner/", isDir: true },
      { path: "src/", isDir: true },
      { path: "src/App.tsx", isDir: false },
    ]);
  });

  it("目录段命中 denylist 的整条丢掉（已跟踪的 build/ vendor/ 改前就看不见，保持），而且不会因此补出空的祖先目录", () => {
    const r = entriesFromPaths([
      "node_modules/a.js",
      "a/node_modules/b.js",
      "build/x.js",
      "src/dist/y.js",
      "vendor/z/w.go",
      "ok.ts",
    ]);

    expect(paths(r)).toEqual(["ok.ts"]);
  });

  it("嵌套仓库本身叫 denylist 里的名字（out/、lib/out/）：同样丢掉", () => {
    expect(paths(entriesFromPaths(["out/", "lib/out/", "src/App.tsx"]))).toEqual(["src/", "src/App.tsx"]);
  });

  it("文件名恰好叫 out / tmp / build 的文件不误杀：denylist 只管目录段", () => {
    expect(paths(entriesFromPaths(["lib/out", "tmp", "src/build"]))).toEqual([
      "lib/",
      "lib/out",
      "tmp",
      "src/",
      "src/build",
    ]);
  });

  it("畸形路径（空串、开头 /、连续 //）跳过；全被过滤时返回空、不算截断", () => {
    expect(paths(entriesFromPaths(["", "/abs/x.ts", "a//b.ts", "ok.ts"]))).toEqual(["ok.ts"]);
    expect(entriesFromPaths(["node_modules/a.js", "", "build/b.js"])).toEqual({ entries: [], truncated: false });
    expect(entriesFromPaths([])).toEqual({ entries: [], truncated: false });
  });

  it("恰好等于上限不算截断；多一条才算", () => {
    expect(entriesFromPaths(["a.ts", "b.ts"], 2)).toEqual({
      entries: [
        { path: "a.ts", isDir: false },
        { path: "b.ts", isDir: false },
      ],
      truncated: false,
    });
    expect(entriesFromPaths(["a.ts", "b.ts"], 1)).toEqual({
      entries: [{ path: "a.ts", isDir: false }],
      truncated: true,
    });
  });

  it("超限：按深度从浅到深留，同深度保持 git 给的顺序；留下的条目其祖先目录都在", () => {
    const input = ["z/y/x/w.ts", "a.ts", "b/c.ts", "d.ts", "e.ts", "f.ts"];

    const r = entriesFromPaths(input, 8);

    expect(r.truncated).toBe(true);
    expect(paths(r)).toEqual(["z/", "a.ts", "b/", "d.ts", "e.ts", "f.ts", "z/y/", "b/c.ts"]);
    const kept = new Set(paths(r));
    for (const p of kept) {
      const segs = p.replace(/\/$/, "").split("/");
      for (let i = 1; i < segs.length; i++) {
        expect(kept.has(`${segs.slice(0, i).join("/")}/`), `${p} 的祖先 ${segs.slice(0, i).join("/")}/`).toBe(true);
      }
    }
  });

  it("默认上限就是 REPO_FILES_MAX_ENTRIES：20,001 条留 20,000 条并标截断，恰好 20,000 条不标", () => {
    const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}.txt`);

    const over = entriesFromPaths(names(REPO_FILES_MAX_ENTRIES + 1));
    expect(over.truncated).toBe(true);
    expect(over.entries.length).toBe(REPO_FILES_MAX_ENTRIES);
    expect(over.entries[0]?.path).toBe("f0.txt");
    expect(over.entries[REPO_FILES_MAX_ENTRIES - 1]?.path).toBe(`f${REPO_FILES_MAX_ENTRIES - 1}.txt`);

    const exact = entriesFromPaths(names(REPO_FILES_MAX_ENTRIES));
    expect(exact.truncated).toBe(false);
    expect(exact.entries.length).toBe(REPO_FILES_MAX_ENTRIES);
  });
});

// ---------------------------------------------------------------------- scanRepoRoot

describe("scanRepoRoot：目录遍历（git 不通时的退路）", () => {
  it("浅层优先：排在 src 前面的深而窄的大目录，额度用完时丢的是它最深的几层，src 照收", async () => {
    const root = mkRoot();
    for (const dir of ["aaa", "aaa/d1", "aaa/d1/d2", "aaa/d1/d2/d3"]) {
      for (const f of ["f1.txt", "f2.txt", "f3.txt"]) put(root, `${dir}/${f}`);
    }
    put(root, "src/App.tsx");

    const r = await scanRepoRoot(root, 10);

    expect(r.truncated).toBe(true);
    expect(paths(r)).toEqual([
      "aaa/",
      "src/",
      "aaa/d1/",
      "aaa/f1.txt",
      "aaa/f2.txt",
      "aaa/f3.txt",
      "src/App.tsx",
      "aaa/d1/d2/",
      "aaa/d1/f1.txt",
      "aaa/d1/f2.txt",
    ]);
    expect(paths(r)).not.toContain("aaa/d1/d2/d3/f1.txt");
  });

  it("目录条目带尾 /、isDir 为 true；文件不带", async () => {
    const root = mkRoot();
    put(root, "src/App.tsx");

    expect((await scanRepoRoot(root)).entries).toEqual([
      { path: "src/", isDir: true },
      { path: "src/App.tsx", isDir: false },
    ]);
  });

  it("恰好收满不算截断；多一个才算", async () => {
    const root = mkRoot();
    for (const f of ["a.ts", "b.ts", "c.ts"]) put(root, f);

    expect(await scanRepoRoot(root, 3)).toEqual({
      entries: [
        { path: "a.ts", isDir: false },
        { path: "b.ts", isDir: false },
        { path: "c.ts", isDir: false },
      ],
      truncated: false,
    });
    expect(await scanRepoRoot(root, 2)).toEqual({
      entries: [
        { path: "a.ts", isDir: false },
        { path: "b.ts", isDir: false },
      ],
      truncated: true,
    });
  });

  it("被 denylist 跳过的目录既不占额度、也不会触发截断", async () => {
    const root = mkRoot();
    put(root, "a.ts");
    put(root, "node_modules/pkg/index.js");
    put(root, "dist/bundle.js");

    expect(await scanRepoRoot(root, 1)).toEqual({
      entries: [{ path: "a.ts", isDir: false }],
      truncated: false,
    });
  });

  it("不存在 / 读不了的 root：返回空、不抛错", async () => {
    expect(await scanRepoRoot(path.join(TMP, "does-not-exist"))).toEqual({ entries: [], truncated: false });
  });

  it.skipIf(process.platform === "win32")("不跟随软链：目录软链、文件软链都不收，也不会扫到 root 外面去", async () => {
    const root = mkRoot();
    const outside = path.join(TMP, `outside-${seq}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "");
    put(root, "real/a.ts");
    fs.symlinkSync(outside, path.join(root, "link-dir"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-file"));

    expect(paths(await scanRepoRoot(root))).toEqual(["real/", "real/a.ts"]);
  });
});

// ---------------------------------------------------------------------- denylist

/** 改前就有的 */
const OLD_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "out",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "Pods",
  ".pnpm-store",
  ".yarn",
  "tmp",
  "temp",
  ".idea",
  ".vscode",
];
/** B6-5 补的：框架 / 工具链的缓存与产物目录，体积大、名字又常排在 src 前面 */
const NEW_IGNORE_DIRS = [
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".gradle",
  ".dart_tool",
  ".terraform",
  "DerivedData",
  ".angular",
  ".parcel-cache",
  ".expo",
  ".vite",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
];

describe("denylist 名单", () => {
  it("名单钉死：改前的全在，B6-5 补的 14 个全在，没有别的（增减都要有人来改这里）", () => {
    expect([...REPO_SCAN_IGNORE_DIRS].sort()).toEqual([...OLD_IGNORE_DIRS, ...NEW_IGNORE_DIRS].sort());
    expect(NEW_IGNORE_DIRS.length).toBe(14);
  });

  it.each([...OLD_IGNORE_DIRS, ...NEW_IGNORE_DIRS])("遍历时 %s/ 整个目录不进索引", async (dir) => {
    const root = mkRoot();
    put(root, `${dir}/inner/file.txt`);
    put(root, "src/App.tsx");

    expect(paths(await scanRepoRoot(root))).toEqual(["src/", "src/App.tsx"]);
  });

  it.each(NEW_IGNORE_DIRS)("git 清单里 %s/ 下的已跟踪文件同样看不见", (dir) => {
    expect(paths(entriesFromPaths([`${dir}/x.js`, `pkg/${dir}/y.js`, "src/App.tsx"]))).toEqual(["src/", "src/App.tsx"]);
  });
});
