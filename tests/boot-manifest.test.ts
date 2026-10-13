/** 启动文件清单工具：路径归一 / 噪声排除 / 目录展开 / 静态资源提取 / 录制器预加载脚本。 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MANIFEST_VERSION,
  buildManifest,
  extractStaticAssetUrls,
  isExcluded,
  listTree,
  mergeUnique,
  toRelativePosix,
} from "../scripts/lib/boot-manifest.mjs";

describe("toRelativePosix", () => {
  const root = path.resolve("/srv/app");

  it("换成相对 server 目录的 POSIX 路径，保序去重，目录外的丢弃", () => {
    const out = toRelativePosix(
      [root],
      [
        path.join(root, "server.js"),
        path.join(root, "node_modules", "next", "dist", "a.js"),
        path.join(root, "server.js"), // 重复
        path.resolve("/usr/lib/libfoo.so"), // 目录外
        path.resolve("/srv/app2/x.js"), // 前缀相同但不是子目录
        root, // 根目录本身不是文件
      ],
    );
    expect(out).toEqual(["server.js", "node_modules/next/dist/a.js"]);
  });

  it("多个 root（原始路径 + realpath）：server.js 会 chdir 到 realpath，录到的是真实路径", () => {
    const link = path.resolve("/tmp/link-app");
    const real = path.resolve("/private/tmp/real-app");
    const out = toRelativePosix([link, real], [path.join(real, "x", "y.js"), path.join(link, "z.js")]);
    expect(out).toEqual(["x/y.js", "z.js"]);
  });

  it("排除噪声：构建缓存 / nft trace / sourcemap / 清单自己", () => {
    const out = toRelativePosix(
      [root],
      [
        path.join(root, ".next", "cache", "fetch-cache", "a"),
        path.join(root, ".next", "server", "app", "page.js.nft.json"),
        path.join(root, "node_modules", "x", "index.js.map"),
        path.join(root, "boot-manifest.json"),
        path.join(root, ".next", "server", "app", "page.js"),
      ],
    );
    expect(out).toEqual([".next/server/app/page.js"]);
    expect(isExcluded(".next/cache/x")).toBe(true);
    expect(isExcluded(".next/server/a.js")).toBe(false);
  });

  it("非字符串 / 空串直接跳过、不抛错", () => {
    expect(toRelativePosix([root], ["", null as unknown as string, 1 as unknown as string])).toEqual([]);
  });
});

describe("mergeUnique / buildManifest", () => {
  it("合并保序去重：前面的清单优先（启动期实际读到的排在前面）", () => {
    expect(mergeUnique(["a", "b"], ["b", "c"], ["a", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("清单对象：版本 / 条数 / 总字节 / 来源 / 生成时间", () => {
    const m = buildManifest({ files: ["a", "b"], totalBytes: 123, meta: { now: 0, source: "traced=2" } });
    expect(m).toEqual({
      version: MANIFEST_VERSION,
      generatedAt: "1970-01-01T00:00:00.000Z",
      count: 2,
      totalBytes: 123,
      source: "traced=2",
      files: ["a", "b"],
    });
  });
});

describe("listTree", () => {
  it("递归列出文件（POSIX 相对路径、排序稳定、排除 nft.json），目录不存在不抛错", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "listtree-test-"));
    try {
      mkdirSync(path.join(root, ".next", "server", "app", "x"), { recursive: true });
      writeFileSync(path.join(root, ".next", "server", "b.js"), "");
      writeFileSync(path.join(root, ".next", "server", "a.js"), "");
      writeFileSync(path.join(root, ".next", "server", "app", "x", "page.js"), "");
      writeFileSync(path.join(root, ".next", "server", "app", "x", "page.js.nft.json"), "");
      expect(listTree(root, ".next/server", { readdirSync })).toEqual([
        ".next/server/a.js",
        ".next/server/app/x/page.js",
        ".next/server/b.js",
      ]);
      expect(listTree(root, "nope", { readdirSync })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractStaticAssetUrls", () => {
  it("从 HTML 抠出 /_next/static 资源、去重、遇到引号 / 括号 / 反斜杠截断", () => {
    const html =
      '<script src="/_next/static/chunks/main-abc.js" async></script>' +
      '<link rel="stylesheet" href="/_next/static/css/app.css"/>' +
      '<script src="/_next/static/chunks/main-abc.js"></script>' +
      "url(/_next/static/media/font.woff2)" +
      '\\"/_next/static/chunks/x.js\\"';
    expect(extractStaticAssetUrls(html)).toEqual([
      "/_next/static/chunks/main-abc.js",
      "/_next/static/css/app.css",
      "/_next/static/media/font.woff2",
      "/_next/static/chunks/x.js",
    ]);
  });

  it("有条数上限", () => {
    const html = Array.from({ length: 500 }, (_, i) => `"/_next/static/chunks/${i}.js"`).join("");
    expect(extractStaticAssetUrls(html, 300)).toHaveLength(300);
  });
});

describe("录制器预加载脚本（boot-trace-preload.cjs）", () => {
  const preload = path.resolve(import.meta.dirname, "..", "scripts", "lib", "boot-trace-preload.cjs");

  const runWithPreload = (script: string, cwd: string, extraEnv: Record<string, string> = {}) => {
    const traceFile = path.join(cwd, "trace.json");
    const res = spawnSync(process.execPath, ["--require", preload, "-e", script], {
      cwd,
      // 刻意不继承宿主 env（NODE_OPTIONS 等会干扰预加载）；Next 的类型增强要求 ProcessEnv 带 NODE_ENV，故经 unknown 断言
      env: { PATH: process.env.PATH ?? "", FLOWSHIP_BOOT_TRACE_OUT: traceFile, ...extraEnv } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(readFileSync(traceFile, "utf8")).files as string[];
  };

  it("录到 readFileSync / openSync / promises.readFile / createReadStream 读过的路径，按首次访问顺序、去重；也不录自己的写入", () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trace-test-")));
    try {
      writeFileSync(path.join(dir, "a.txt"), "a");
      writeFileSync(path.join(dir, "b.txt"), "b");
      writeFileSync(path.join(dir, "c.txt"), "c");
      writeFileSync(path.join(dir, "d.txt"), "d");
      const files = runWithPreload(
        `
        const fs = require("node:fs");
        fs.readFileSync("a.txt");
        fs.closeSync(fs.openSync("b.txt", "r"));
        fs.readFileSync("a.txt");
        fs.createReadStream("c.txt").on("data", () => {}).on("close", () => {
          fs.promises.readFile("d.txt").then(() => {});
        });
        setTimeout(() => {}, 200);
        `,
        dir,
      );
      const names = files.filter((f) => f.startsWith(dir)).map((f) => path.basename(f));
      expect(names.slice(0, 2)).toEqual(["a.txt", "b.txt"]);
      expect(names).toContain("c.txt");
      expect(names).toContain("d.txt");
      expect(names.filter((n) => n === "a.txt")).toHaveLength(1);
      expect(names).not.toContain("trace.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没设 FLOWSHIP_BOOT_TRACE_OUT 时什么都不做（不打补丁、不落盘）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "trace-off-"));
    try {
      const res = spawnSync(
        process.execPath,
        ["--require", preload, "-e", 'console.log(String(require("node:fs").readFileSync).includes("patched"))'],
        { cwd: dir, env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
      );
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
