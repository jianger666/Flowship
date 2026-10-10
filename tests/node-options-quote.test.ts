/**
 * NODE_OPTIONS 取值引用（electron-app/node-options.mjs + main.js 接线契约）
 *
 * 回归背景：壳给 server 子进程注入 `--report-directory=<userData>/data/diagnostics/node-reports`，
 * macOS 的 userData 在「Application Support」下、含空格；NODE_OPTIONS 按空格切词，不加引号时
 * Node 只取到 `/…/Library/Application`、后半段被静默丢弃，崩溃取证报告写不出来、且没有任何报错。
 *
 * 钉死的语义：
 * - 不含空格 / 引号的取值保持原样（不加引号，行为与过去完全一致）
 * - 含空格 / 引号 / 反斜杠的取值，经**真 Node** 解析后 process.report.directory 与原值逐字符相等（往返）
 * - main.js 接线：`--report-directory` 必须经 quoteNodeOptionValue；main.js 引入的本地 .mjs 必须存在且会被打进包
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { quoteNodeOptionValue } from "../electron-app/node-options.mjs";

const root = path.resolve(import.meta.dirname, "..");
const main = readFileSync(path.join(root, "electron-app/main.js"), "utf8");

/** 把取值经 quoteNodeOptionValue 塞进 NODE_OPTIONS，让真 Node 解析后读回 */
const roundTrip = (dir: string): string => {
  const r = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.report.directory)"],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=512 --report-directory=${quoteNodeOptionValue(dir)}`,
      },
      encoding: "utf8",
    },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

describe("quoteNodeOptionValue（纯函数）", () => {
  it("不含空格 / 引号：原样返回（含无空格的 Windows 路径，引号外反斜杠本来就是普通字符）", () => {
    expect(quoteNodeOptionValue("/tmp/plain/dir")).toBe("/tmp/plain/dir");
    expect(quoteNodeOptionValue("C:\\Users\\Name\\AppData\\Roaming")).toBe(
      "C:\\Users\\Name\\AppData\\Roaming",
    );
    expect(quoteNodeOptionValue("")).toBe("");
  });

  it("含空格：整体加双引号；引号内的反斜杠与引号各补一个反斜杠", () => {
    expect(quoteNodeOptionValue("/Users/x/Library/Application Support/a")).toBe(
      '"/Users/x/Library/Application Support/a"',
    );
    expect(quoteNodeOptionValue("C:\\Users\\John Doe\\AppData")).toBe(
      '"C:\\\\Users\\\\John Doe\\\\AppData"',
    );
    expect(quoteNodeOptionValue('a"b c')).toBe('"a\\"b c"');
  });

  it("制表符 / 换行也算空白：同样加引号", () => {
    expect(quoteNodeOptionValue("a\tb")).toBe('"a\tb"');
  });
});

describe("真 Node 往返：process.report.directory 与原值逐字符相等", () => {
  it.each([
    ["正式包真实形态（macOS Application Support，回归用例）", "/Users/x/Library/Application Support/fe-ai-flow/data/diagnostics/node-reports"],
    ["无空格", "/tmp/plain/dir"],
    ["连续两个空格", "/tmp/two  spaces/dir"],
    ["反斜杠 + 空格（POSIX 下合法）", "/tmp/back\\slash and space/dir"],
    ["引号字符 + 空格", '/tmp/qu"ote and space/dir'],
    ["Windows 风格：用户名带空格", "C:\\Users\\John Doe\\AppData\\Roaming\\Flowship\\data\\diagnostics"],
    ["Windows 风格：无空格（不加引号也必须原样）", "C:\\Users\\Name\\AppData\\Roaming\\Flowship"],
    ["中文 + 空格", "/tmp/中文 目录/报告"],
  ])("%s", (_name, dir) => {
    expect(roundTrip(dir)).toBe(dir);
  });

  it("对照：不加引号时含空格的取值确实会被截断（证明这个函数有存在的必要）", () => {
    const dir = "/tmp/has space/dir";
    const r = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.report.directory)"],
      {
        env: { ...process.env, NODE_OPTIONS: `--report-directory=${dir}` },
        encoding: "utf8",
      },
    );
    expect(r.stdout).not.toBe(dir);
    expect(r.stdout).toBe("/tmp/has");
  });
});

describe("main.js 接线契约", () => {
  it("--report-directory 经 quoteNodeOptionValue，且不再有未加引号的写法", () => {
    expect(main).toContain(
      'import { quoteNodeOptionValue } from "./node-options.mjs";',
    );
    expect(main).toMatch(
      /--report-directory=\$\{quoteNodeOptionValue\(nodeReportDir\)\}/,
    );
    expect(main).not.toMatch(/--report-directory=\$\{nodeReportDir\}/);
  });

  it("main.js 引入的本地模块都真实存在，且 electron-builder 不会把它们漏出包外", () => {
    const rels = [...main.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(existsSync(path.join(root, "electron-app", rel)), rel).toBe(true);
    }
    // 未配置 files 白名单 = 默认打包整个 app 目录，新增 .mjs 自动带上；
    // 一旦将来加了白名单，必须把这些模块都列进去，否则打出来的包启动即崩
    const pkg = JSON.parse(
      readFileSync(path.join(root, "electron-app/package.json"), "utf8"),
    ) as { build?: { files?: string[] } };
    const files = pkg.build?.files;
    if (files) {
      for (const rel of rels) {
        const name = rel.replace(/^\.\//, "");
        const covered = files.some(
          (p) => p === name || p === "*.mjs" || p === "**/*" || p === "**",
        );
        expect(covered, `${name} 未被 build.files 覆盖`).toBe(true);
      }
    }
  });
});
