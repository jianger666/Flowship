import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mergePathStrings } from "@/lib/server/login-shell-path";
import {
  injectSdkRgPathFrom,
  resolveSdkRgPath,
  resolveSdkRgPathFrom,
} from "@/lib/server/sdk-platform-bin";

const plat = `sdk-${process.platform}-${process.arch}`;
const rgName = process.platform === "win32" ? "rg.exe" : "rg";

const tmpRoot = (): string =>
  path.join(
    os.tmpdir(),
    `flowship-sdk-rg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

const writeRg = (binDir: string): string => {
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, rgName);
  writeFileSync(file, "fake-rg");
  return file;
};

describe("resolveSdkRgPathFrom", () => {
  it("hoisted 顶层 @cursor/sdk-<platform>/bin/rg", () => {
    const root = tmpRoot();
    const file = writeRg(path.join(root, "node_modules", "@cursor", plat, "bin"));
    expect(resolveSdkRgPathFrom(root)).toBe(file);
  });

  it("pnpm 实体目录 .pnpm/@cursor+sdk-<platform>@*/.../bin/rg", () => {
    const root = tmpRoot();
    const file = writeRg(
      path.join(
        root,
        "node_modules",
        ".pnpm",
        `@cursor+${plat}@1.0.30`,
        "node_modules",
        "@cursor",
        plat,
        "bin",
      ),
    );
    expect(resolveSdkRgPathFrom(root)).toBe(file);
  });

  it("没有平台包返回 null", () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    expect(resolveSdkRgPathFrom(root)).toBeNull();
  });

  it("pnpm：跟 @cursor/sdk 同级的平台包（assemble 后的布局）", () => {
    if (process.platform === "win32") return;
    const root = tmpRoot();
    const cursorDir = path.join(
      root,
      "node_modules",
      ".pnpm",
      "fake",
      "node_modules",
      "@cursor",
    );
    const file = writeRg(path.join(cursorDir, plat, "bin"));
    mkdirSync(path.join(cursorDir, "sdk"), { recursive: true });
    writeFileSync(path.join(cursorDir, "sdk", "package.json"), "{}");
    mkdirSync(path.join(root, "node_modules", "@cursor"), { recursive: true });
    symlinkSync(
      path.join(cursorDir, "sdk"),
      path.join(root, "node_modules", "@cursor", "sdk"),
    );
    expect(resolveSdkRgPathFrom(root)).toBe(realpathSync(file));
  });

  it("本仓库 node_modules 能解析到真实 rg", () => {
    const file = resolveSdkRgPath();
    expect(file).toBeTruthy();
    expect(existsSync(file!)).toBe(true);
  });
});

describe("injectSdkRgPathFrom", () => {
  const prev = process.env.PATH;

  afterEach(() => {
    process.env.PATH = prev;
  });

  it("把 rg 所在目录前置进 PATH，第二次调用幂等", () => {
    const root = tmpRoot();
    const file = writeRg(path.join(root, "node_modules", "@cursor", plat, "bin"));
    const bin = path.dirname(file);
    process.env.PATH = ["/usr/bin", "/bin"].join(path.delimiter);

    injectSdkRgPathFrom(root);
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(bin);

    const once = process.env.PATH;
    injectSdkRgPathFrom(root);
    expect(process.env.PATH).toBe(once);
  });
});

describe("login PATH pin 含 SDK rg", () => {
  it("tools/bin 在最前、sdk rg 次之", () => {
    expect(
      mergePathStrings(
        "/opt/homebrew/bin:/usr/bin",
        "/usr/bin:/x/sdk-rg:/x/tools/bin",
        ["/x/tools/bin", "/x/sdk-rg"],
      ),
    ).toBe("/x/tools/bin:/x/sdk-rg:/opt/homebrew/bin:/usr/bin");
  });
});
