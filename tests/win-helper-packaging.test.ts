/**
 * Windows 解锁组件的打包链路（scripts/lib/win-helper-hashes.mjs、scripts/win-helper-hashes.mjs、afterPack、main.js 接线）。
 *
 * 要防的事故：包打出来了，但用户点「安装解锁组件」永远装不上——
 * - 资源文件改了、忘了更新 protocol.mjs 里的期望哈希（引导程序校验不过就一律不运行）
 * - afterPack 没把资源拷到 resources/win-helper/（PowerShell 读不了 asar 里的文件）
 * - 拷过去的和登记的哈希对不上，却照样发了版
 * - 目录名 / 路径在 afterPack、main.js、安装器三处写得不一致
 * 这些都只有装到真机上点了才知道；这里把它们变成构建期 / 单测期就会红的东西。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ASSET_FILES, HELPER_ASSET_SHA256, assetSha256 } from "../electron-app/desktop/win-helper/protocol.mjs";
import {
  BEGIN_MARK,
  END_MARK,
  assetsDirOf,
  computeAssetHashes,
  installWinHelperAssets,
  protocolPathOf,
  renderHashBlock,
  rewriteHashBlock,
  syncAssetHashes,
} from "../scripts/lib/win-helper-hashes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const tmpDirs: string[] = [];
const mkTmp = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flowship-pack-${name}-`));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DEFAULT_FILES: Record<string, string | Buffer> = {
  [ASSET_FILES.source]: "class A {}\n",
  [ASSET_FILES.install]: "exit 0\n",
  [ASSET_FILES.uninstall]: "exit 0\n",
};

/** 在临时目录里造一个「迷你仓库」：只有 assets 三个文件（和可选的 protocol.mjs） */
const makeRepo = (files: Record<string, string | Buffer> = DEFAULT_FILES, protocolSource?: string) => {
  const root = mkTmp("repo");
  const assets = assetsDirOf(root);
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), content);
  if (protocolSource !== undefined) fs.writeFileSync(protocolPathOf(root), protocolSource);
  return { root, assets };
};

const hashesOf = (files: Record<string, string | Buffer>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([name, content]) => [name, assetSha256(Buffer.from(content))]));

describe("installWinHelperAssets：afterPack 把资源拷进 resources/win-helper/", () => {
  it("真实仓库：三个文件逐字节拷贝，落在 <resources>/win-helper", async () => {
    const resourcesDir = mkTmp("res");
    const dest = await installWinHelperAssets({ repoRoot: ROOT, resourcesDir });
    expect(dest).toBe(path.join(resourcesDir, "win-helper"));
    expect(fs.readdirSync(dest).sort()).toEqual(Object.values(ASSET_FILES).sort());
    for (const name of Object.values(ASSET_FILES)) {
      const copied = fs.readFileSync(path.join(dest, name));
      const original = fs.readFileSync(path.join(assetsDirOf(ROOT), name));
      expect(copied.equals(original), name).toBe(true);
      // 拷过去的就是登记过哈希的那一份
      expect(assetSha256(copied), name).toBe(HELPER_ASSET_SHA256[name as keyof typeof HELPER_ASSET_SHA256]);
    }
  });

  it("按原始字节拷（CRLF / BOM 不动它，规范化是引导程序校验时的事）", async () => {
    const files = {
      [ASSET_FILES.source]: Buffer.from("class A {}\r\n"),
      [ASSET_FILES.install]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("exit 0\r\n")]),
      [ASSET_FILES.uninstall]: "exit 0\n",
    };
    const { root } = makeRepo(files);
    const resourcesDir = mkTmp("res");
    const dest = await installWinHelperAssets({ repoRoot: root, resourcesDir, expected: hashesOf(files) });
    for (const [name, content] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(dest, name)).equals(Buffer.from(content)), name).toBe(true);
    }
  });

  it("resources 目录还不存在也行（自己建）；目标目录里的旧东西会先清掉", async () => {
    const { root } = makeRepo();
    const resourcesDir = path.join(mkTmp("res"), "not", "yet", "there");
    const stale = path.join(resourcesDir, "win-helper", "stale.txt");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "旧版本留下的");
    const dest = await installWinHelperAssets({ repoRoot: root, resourcesDir, expected: hashesOf(DEFAULT_FILES) });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(dest).sort()).toEqual(Object.values(ASSET_FILES).sort());
  });

  it("文件和登记的哈希对不上：构建失败，报出文件名并告诉怎么修", async () => {
    const { root } = makeRepo();
    const wrong = { ...hashesOf(DEFAULT_FILES), [ASSET_FILES.install]: "0".repeat(64) };
    const err = await installWinHelperAssets({ repoRoot: root, resourcesDir: mkTmp("res"), expected: wrong }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(ASSET_FILES.install);
    expect(err?.message).toContain("node scripts/win-helper-hashes.mjs");
  });

  it("某个文件根本没登记哈希：同样失败，不能当成「不用校验」", async () => {
    const { root } = makeRepo();
    const partial: Record<string, string> = hashesOf(DEFAULT_FILES);
    delete partial[ASSET_FILES.uninstall];
    await expect(installWinHelperAssets({ repoRoot: root, resourcesDir: mkTmp("res"), expected: partial })).rejects.toThrow(ASSET_FILES.uninstall);
    // 登记成空串也不行
    await expect(
      installWinHelperAssets({ repoRoot: root, resourcesDir: mkTmp("res"), expected: { ...hashesOf(DEFAULT_FILES), [ASSET_FILES.source]: "" } }),
    ).rejects.toThrow(ASSET_FILES.source);
  });

  it("源文件缺失：失败，报出缺哪个文件、告诉去哪里补（不是一句光秃秃的 ENOENT）", async () => {
    for (const missing of Object.values(ASSET_FILES)) {
      const { root, assets } = makeRepo();
      fs.rmSync(path.join(assets, missing));
      const err = await installWinHelperAssets({ repoRoot: root, resourcesDir: mkTmp("res"), expected: hashesOf(DEFAULT_FILES) }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err, missing).toBeInstanceOf(Error);
      expect(err?.message, missing).toContain(missing);
      expect(err?.message, missing).toContain("electron-app/desktop/win-helper/assets/");
      expect(err?.message, missing).not.toContain("ENOENT");
    }
  });
});

describe("rewriteHashBlock / renderHashBlock：把哈希写回 protocol.mjs", () => {
  const SOURCE = [
    "// 头部：别动",
    "export const BEFORE = 1;",
    BEGIN_MARK,
    "export const HELPER_ASSET_SHA256 = Object.freeze({",
    '  "FlowshipUnlockHelper.cs": "OLD",',
    "});",
    END_MARK,
    "export const AFTER = 2;",
    "",
  ].join("\n");
  const HASHES = {
    [ASSET_FILES.source]: "A".repeat(64),
    [ASSET_FILES.install]: "B".repeat(64),
    [ASSET_FILES.uninstall]: "C".repeat(64),
  };

  it("只替换两个标记之间的内容，前后原样保留", () => {
    const out = rewriteHashBlock(SOURCE, HASHES);
    expect(out.startsWith("// 头部：别动\nexport const BEFORE = 1;\n" + BEGIN_MARK + "\n")).toBe(true);
    expect(out.endsWith(END_MARK + "\nexport const AFTER = 2;\n")).toBe(true);
    expect(out).not.toContain("OLD");
    for (const name of Object.values(ASSET_FILES)) expect(out).toContain(`"${name}": "${HASHES[name]}"`);
  });

  it("幂等：同样的哈希再写一遍，结果不变", () => {
    const once = rewriteHashBlock(SOURCE, HASHES);
    expect(rewriteHashBlock(once, HASHES)).toBe(once);
  });

  it("写出来的块是合法的 JS：能被求值，得到「文件名 → 哈希」", () => {
    const block = renderHashBlock(HASHES).replace("export const", "const");
    const value = new Function(`${block}; return HELPER_ASSET_SHA256;`)();
    expect(value).toEqual(HASHES);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("找不到标记 / 标记顺序反了：报错，不乱写", () => {
    expect(() => rewriteHashBlock("export const A = 1;\n", HASHES)).toThrow("找不到资源哈希的标记");
    expect(() => rewriteHashBlock(`${END_MARK}\n${BEGIN_MARK}\n`, HASHES)).toThrow("找不到资源哈希的标记");
  });

  it("哈希不合法（小写 / 长度不对 / 缺失）：报错", () => {
    expect(() => rewriteHashBlock(SOURCE, { ...HASHES, [ASSET_FILES.install]: "b".repeat(64) })).toThrow(ASSET_FILES.install);
    expect(() => rewriteHashBlock(SOURCE, { ...HASHES, [ASSET_FILES.install]: "B".repeat(63) })).toThrow(ASSET_FILES.install);
    const missing: Record<string, string> = { ...HASHES };
    delete missing[ASSET_FILES.uninstall];
    expect(() => rewriteHashBlock(SOURCE, missing)).toThrow(ASSET_FILES.uninstall);
  });
});

describe("syncAssetHashes：重算并写回", () => {
  const PROTOCOL = [`export const BEFORE = 1;`, BEGIN_MARK, `export const HELPER_ASSET_SHA256 = Object.freeze({});`, END_MARK, `export const AFTER = 2;`, ""].join("\n");

  it("只检查（write:false）：报告有变化，但不动文件", async () => {
    const { root } = makeRepo(DEFAULT_FILES, PROTOCOL);
    const result = await syncAssetHashes({ repoRoot: root, write: false });
    expect(result.changed).toBe(true);
    expect(result.hashes).toEqual(hashesOf(DEFAULT_FILES));
    expect(fs.readFileSync(protocolPathOf(root), "utf8")).toBe(PROTOCOL);
  });

  it("写回之后再检查：一致；资源文件一变又不一致", async () => {
    const { root, assets } = makeRepo(DEFAULT_FILES, PROTOCOL);
    expect((await syncAssetHashes({ repoRoot: root })).changed).toBe(true);
    const written = fs.readFileSync(protocolPathOf(root), "utf8");
    for (const [name, hash] of Object.entries(hashesOf(DEFAULT_FILES))) expect(written).toContain(`"${name}": "${hash}"`);
    expect((await syncAssetHashes({ repoRoot: root, write: false })).changed).toBe(false);
    expect((await syncAssetHashes({ repoRoot: root })).changed).toBe(false);

    fs.appendFileSync(path.join(assets, ASSET_FILES.install), "# 改了一行\n");
    expect((await syncAssetHashes({ repoRoot: root, write: false })).changed).toBe(true);
  });

  it("换行风格不影响哈希（Windows 上 git 转成 CRLF 也不会让校验失败）", async () => {
    const lf = makeRepo({ ...DEFAULT_FILES, [ASSET_FILES.install]: "a\nb\nc\n" });
    const crlf = makeRepo({ ...DEFAULT_FILES, [ASSET_FILES.install]: "a\r\nb\r\nc\r\n" });
    const bom = makeRepo({ ...DEFAULT_FILES, [ASSET_FILES.install]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\nb\nc\n")]) });
    const a = await computeAssetHashes(lf.assets);
    const b = await computeAssetHashes(crlf.assets);
    const c = await computeAssetHashes(bom.assets);
    expect(b[ASSET_FILES.install]).toBe(a[ASSET_FILES.install]);
    expect(c[ASSET_FILES.install]).toBe(a[ASSET_FILES.install]);
  });
});

describe("真实仓库：资源文件和登记的哈希一致", () => {
  it("node scripts/win-helper-hashes.mjs --check 退出码为 0", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "win-helper-hashes.mjs"), "--check"], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("一致");
  });

  it("三个资源文件：LF 换行、没有 BOM（.gitattributes 钉死 LF，哈希对它们稳定）", () => {
    for (const name of Object.values(ASSET_FILES)) {
      const bytes = fs.readFileSync(path.join(assetsDirOf(ROOT), name));
      expect(bytes.includes(0x0d), `${name} 里有 CR`).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${name} 带 BOM`).toBe(false);
    }
  });

  it(".gitattributes 把资源目录钉成 LF", () => {
    expect(read(".gitattributes")).toMatch(/^electron-app\/desktop\/win-helper\/assets\/\* text eol=lf$/m);
  });
});

describe("接线：afterPack / main.js / electron-builder 三处对得上", () => {
  it("afterPack 只在 win32 上拷资源，并且用 installWinHelperAssets（带哈希校验）", () => {
    const src = read("scripts", "electron-after-pack.mjs");
    expect(src).toMatch(/import \{ installWinHelperAssets \} from "\.\/lib\/win-helper-hashes\.mjs";/);
    expect(src).toMatch(/if \(context\.electronPlatformName === "win32"\) \{\s*const helperDir = await installWinHelperAssets\(\{ repoRoot: process\.cwd\(\), resourcesDir \}\);/);
  });

  it("main.js：打包后到 resources/win-helper 找资源，开发期用源码树（传 undefined）", () => {
    const src = read("electron-app", "main.js");
    expect(src).toMatch(/helperAssetsDir:\s*app\.isPackaged\s*\?\s*path\.join\(process\.resourcesPath,\s*"win-helper"\)\s*:\s*undefined/);
  });

  it("目录名三处一致：afterPack 拷到的目录 = main.js 去找的目录", async () => {
    const dest = await installWinHelperAssets({ repoRoot: ROOT, resourcesDir: mkTmp("res") });
    expect(path.basename(dest)).toBe("win-helper");
    expect(read("electron-app", "main.js")).toContain(`path.join(process.resourcesPath, "${path.basename(dest)}")`);
  });

  it("electron-builder：app 目录是 electron-app（整个 desktop/ 随之进包），没有用 files 把它排除", () => {
    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/^\s+app: electron-app$/m);
    expect(yml).not.toMatch(/^files:/m);
    // 资源不走 extraResources（那条路没有哈希校验），由 afterPack 拷
    expect(yml).not.toContain("win-helper");
  });
});
