/**
 * assemble-server 补运行时包时的顶层 symlink（pnpm isolated 布局）。
 *
 * 事故：本机（isolated）打包时 addRuntimePackage 给 scoped 包（@scope/name）建的顶层 symlink
 * 目标写成 ".pnpm/…"，但链接位于 node_modules/@scope/ 下、少了一层 ".."——链接断掉、被随后的
 * removeBrokenSymlinks 清掉，包里顶层 @earendil-works/* 等全丢，pi 后端运行时 MODULE_NOT_FOUND。
 * CI 用 hoisted 布局不走这个分支，所以官方包一直没暴露，只有本机构建的包会踩。
 *
 * 这里用最小的 pnpm isolated 夹具复现：scoped 包 + 它的 scoped 依赖 + 非 scoped 依赖；
 * 并补一个 hoisted 夹具，保证 CI 走的分支不受影响。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { addRuntimePackage } from "../scripts/lib/assemble-server.mjs";

const tmpDirs: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-links-"));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const writePkg = (dir: string, name: string, deps: Record<string, string> = {}): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies: deps }),
  );
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
};

/** 在 linkPath 建指向 target 的相对 symlink（pnpm 的链接都是相对的） */
const relLink = (linkPath: string, target: string): void => {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
};

const PKG_A = "@scope-a/pkg-a";
const DEP_C = "@scope-a/dep-c";
const PLAIN_B = "plain-b";
const ENC_A = "@scope-a+pkg-a@1.0.0";
const ENC_C = "@scope-a+dep-c@1.0.0";
const ENC_B = "plain-b@1.0.0";

/** 最小 pnpm isolated 夹具：根依赖 PKG_A（scoped）依赖 DEP_C（scoped）与 PLAIN_B（非 scoped） */
const buildIsolatedFixture = (root: string): void => {
  const pnpm = path.join(root, "node_modules", ".pnpm");
  const entity = (enc: string, name: string): string =>
    path.join(pnpm, enc, "node_modules", name);

  writePkg(entity(ENC_A, PKG_A), PKG_A, { [DEP_C]: "1.0.0", [PLAIN_B]: "1.0.0" });
  writePkg(entity(ENC_C, DEP_C), DEP_C);
  writePkg(entity(ENC_B, PLAIN_B), PLAIN_B);

  // pnpm 的兄弟链接：PKG_A 实体的 node_modules 里放它依赖的链接
  relLink(entity(ENC_A, DEP_C), entity(ENC_C, DEP_C));
  relLink(entity(ENC_A, PLAIN_B), entity(ENC_B, PLAIN_B));
  // 根依赖的顶层链接
  relLink(path.join(root, "node_modules", PKG_A), entity(ENC_A, PKG_A));
};

describe("addRuntimePackage：pnpm isolated 布局的顶层链接", () => {
  const run = async (): Promise<{ root: string; dest: string }> => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = mkTmp();
    const dest = mkTmp();
    buildIsolatedFixture(root);
    await addRuntimePackage(root, dest, PKG_A);
    return { root, dest };
  };

  it("scoped 包的顶层链接能解析（回归：少一层 .. 会断链）", async () => {
    const { dest } = await run();
    for (const name of [PKG_A, DEP_C]) {
      const link = path.join(dest, "node_modules", name);
      expect(fs.lstatSync(link).isSymbolicLink(), `${name} 应是 symlink`).toBe(true);
      // 跟随链接读得到包本体 = 链接没断
      const pj = JSON.parse(fs.readFileSync(path.join(link, "package.json"), "utf8"));
      expect(pj.name).toBe(name);
    }
  });

  it("非 scoped 包的顶层链接行为不变（目标仍是 .pnpm/…，与修复前逐字节一致）", async () => {
    const { dest } = await run();
    const link = path.join(dest, "node_modules", PLAIN_B);
    expect(fs.readlinkSync(link)).toBe(path.join(".pnpm", ENC_B, "node_modules", PLAIN_B));
    const pj = JSON.parse(fs.readFileSync(path.join(link, "package.json"), "utf8"));
    expect(pj.name).toBe(PLAIN_B);
  });

  it("顶层链接是相对路径、且解析到 dest 自己的 .pnpm（包拷去别处仍有效）", async () => {
    const { root, dest } = await run();
    const destPnpm = path.join(fs.realpathSync(dest), "node_modules", ".pnpm") + path.sep;
    const rootReal = fs.realpathSync(root) + path.sep;
    for (const name of [PKG_A, DEP_C, PLAIN_B]) {
      const link = path.join(dest, "node_modules", name);
      expect(path.isAbsolute(fs.readlinkSync(link)), `${name} 链接应是相对路径`).toBe(false);
      const real = fs.realpathSync(link);
      expect(real.startsWith(destPnpm), `${name} 应解析到 dest/.pnpm`).toBe(true);
      expect(real.startsWith(rootReal), `${name} 不应指回源目录`).toBe(false);
    }
  });

  it("依赖闭包的实体都补进了 dest/.pnpm", async () => {
    const { dest } = await run();
    for (const enc of [ENC_A, ENC_C, ENC_B]) {
      expect(fs.existsSync(path.join(dest, "node_modules", ".pnpm", enc)), enc).toBe(true);
    }
  });
});

describe("addRuntimePackage：hoisted 布局（CI）不受影响", () => {
  it("平铺实体直接拷贝、不建 symlink、不产生 .pnpm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = mkTmp();
    const dest = mkTmp();
    writePkg(path.join(root, "node_modules", PKG_A), PKG_A, { [PLAIN_B]: "1.0.0" });
    writePkg(path.join(root, "node_modules", PLAIN_B), PLAIN_B);

    await addRuntimePackage(root, dest, PKG_A);

    for (const name of [PKG_A, PLAIN_B]) {
      const p = path.join(dest, "node_modules", name);
      expect(fs.lstatSync(p).isSymbolicLink(), `${name} 不应是 symlink`).toBe(false);
      expect(fs.existsSync(path.join(p, "package.json"))).toBe(true);
    }
    expect(fs.existsSync(path.join(dest, "node_modules", ".pnpm"))).toBe(false);
  });
});
