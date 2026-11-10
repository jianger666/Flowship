/**
 * R6-15：trace / 录制根目录的符号链接校验（共享 ensureSafeDir）。真实临时目录，不用 fake fs（符号链接 / 权限必须是真的才有意义）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSafeDir } from "../electron-app/browser/safe-dir.mjs";
import { createCappedWriter } from "../electron-app/browser/ops/perf.mjs";

const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;

let base = "";
let task = "";
let outside = "";
beforeEach(() => {
  base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "r6s4-safedir-"));
  task = nodePath.join(base, "tasks", "t1");
  outside = nodePath.join(base, "victim");
  nodeFs.mkdirSync(task, { recursive: true, mode: 0o700 });
  nodeFs.mkdirSync(outside, { mode: 0o755 });
  nodeFs.chmodSync(outside, 0o755);
});
afterEach(() => {
  nodeFs.rmSync(base, { recursive: true, force: true });
});

const mode = (p: string) => nodeFs.lstatSync(p).mode & 0o777;

d("ensureSafeDir（R6-15）", () => {
  it("正常创建：逐级建出来，每一级都是真目录、0700", () => {
    const dir = nodePath.join(task, "browser-traces");
    expect(ensureSafeDir(dir, { label: "browser-traces" })).toBe(dir);
    expect(nodeFs.lstatSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
    // 更深的路径（录制子目录）也逐级创建
    const deep = nodePath.join(task, "browser-recordings", "rec-1");
    ensureSafeDir(deep, { root: task });
    expect(mode(nodePath.join(task, "browser-recordings"))).toBe(0o700);
    expect(mode(deep)).toBe(0o700);
    // 幂等
    expect(ensureSafeDir(dir)).toBe(dir);
  });

  it("目标目录本身是符号链接 → 拒绝，且链接目标的权限 / 内容一律没被动", () => {
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.symlinkSync(outside, dir);
    expect(() => ensureSafeDir(dir, { label: "browser-traces" })).toThrow(/不是普通目录|符号链接/);
    expect(mode(outside)).toBe(0o755); // 没被 chmod 成 0700
    expect(nodeFs.readdirSync(outside)).toEqual([]);
  });

  it("中间某一级是符号链接 → 拒绝（不只查最后一级）", () => {
    nodeFs.symlinkSync(outside, nodePath.join(task, "browser-recordings"));
    const deep = nodePath.join(task, "browser-recordings", "rec-1");
    expect(() => ensureSafeDir(deep, { root: task })).toThrow(/符号链接/);
    expect(nodeFs.readdirSync(outside)).toEqual([]); // 没在链接目标里建出 rec-1
  });

  it("任务目录本身被换成符号链接 → 拒绝", () => {
    const real = nodePath.join(base, "tasks", "t2-real");
    nodeFs.mkdirSync(real, { mode: 0o700 });
    const link = nodePath.join(base, "tasks", "t2");
    nodeFs.symlinkSync(real, link);
    expect(() => ensureSafeDir(nodePath.join(link, "browser-traces"))).toThrow(/任务目录.*符号链接|符号链接/);
    expect(nodeFs.readdirSync(real)).toEqual([]);
  });

  it("目标位置是普通文件 → 拒绝", () => {
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.writeFileSync(dir, "x");
    expect(() => ensureSafeDir(dir)).toThrow(/不是普通目录/);
  });

  it("权限被放宽（0755 / 0777）→ 修正回 0700", () => {
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.mkdirSync(dir, { mode: 0o755 });
    nodeFs.chmodSync(dir, 0o755);
    ensureSafeDir(dir);
    expect(mode(dir)).toBe(0o700);
    nodeFs.chmodSync(dir, 0o777);
    ensureSafeDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("权限修正不了（chmod 被吞掉）→ 拒绝，而不是放行", () => {
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.mkdirSync(dir, { mode: 0o755 });
    nodeFs.chmodSync(dir, 0o755);
    const stuck = { ...nodeFs, chmodSync: () => {} } as unknown as typeof nodeFs;
    expect(() => ensureSafeDir(dir, { fs: stuck })).toThrow(/0700/);
  });

  it("属主不是当前用户 → 拒绝", () => {
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.mkdirSync(dir, { mode: 0o700 });
    const foreign = {
      ...nodeFs,
      lstatSync: (p: string) => {
        const st = nodeFs.lstatSync(p);
        return { isSymbolicLink: () => st.isSymbolicLink(), isDirectory: () => st.isDirectory(), mode: st.mode, uid: st.uid + 1 };
      },
    } as unknown as typeof nodeFs;
    expect(() => ensureSafeDir(dir, { fs: foreign })).toThrow(/属主/);
  });

  it("必须位于任务目录之下：`..` 逃逸 / 兄弟目录 / 前缀相同的相邻目录都拒", () => {
    expect(() => ensureSafeDir(nodePath.join(task, "..", "victim", "x"), { root: task })).toThrow(/不在任务目录/);
    expect(() => ensureSafeDir(outside, { root: task })).toThrow(/不在任务目录/);
    expect(() => ensureSafeDir(`${task}-evil/browser-traces`, { root: task })).toThrow(/不在任务目录/);
  });
});

d("perf 的 createCappedWriter 走 ensureSafeDir（R6-15 接线）", () => {
  it("browser-traces 被换成符号链接 → 拒绝落盘；链接目标权限 / 内容不变；旧文件也不会被 prune 误删", () => {
    nodeFs.writeFileSync(nodePath.join(outside, "trace-20200101-000000.json"), "precious");
    const dir = nodePath.join(task, "browser-traces");
    nodeFs.symlinkSync(outside, dir);
    expect(() => createCappedWriter({ dir, prefix: "trace", ext: "json", keep: 0 })).toThrow(/不是普通目录|符号链接/);
    expect(mode(outside)).toBe(0o755);
    expect(nodeFs.readFileSync(nodePath.join(outside, "trace-20200101-000000.json"), "utf8")).toBe("precious");
  });

  it("正常目录：写入器照常工作，文件 0600，目录 0700", () => {
    const dir = nodePath.join(task, "browser-traces");
    const w = createCappedWriter({ dir, prefix: "trace", ext: "json" });
    expect(mode(dir)).toBe(0o700);
    w.abort();
  });
});

describe("R6-15 接线合同：perf / record 不再裸 mkdir + chmod", () => {
  it("perf.mjs 的 createCappedWriter 与 record.mjs 的 ensureDir / 录制子目录都调用 ensureSafeDir", () => {
    const perf = nodeFs.readFileSync(new URL("../electron-app/browser/ops/perf.mjs", import.meta.url), "utf8");
    const record = nodeFs.readFileSync(new URL("../electron-app/browser/ops/record.mjs", import.meta.url), "utf8");
    expect(perf).toMatch(/import \{ ensureSafeDir \} from "\.\.\/safe-dir\.mjs"/);
    expect(perf).toMatch(/ensureSafeDir\(dir, \{ fs, label: "browser-traces" \}\)/);
    expect(perf).not.toMatch(/fs\.mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\);\s*\n\s*if \(unixMode\(\)\) fs\.chmodSync\(dir, 0o700\)/);
    expect(record).toMatch(/import \{ ensureSafeDir \} from "\.\.\/safe-dir\.mjs"/);
    // R6-37：label 由调用方给（不再硬编码 browser-recordings），导出目录 / 已有录制目录同样经它（行为见 tests/browser-r6-s5-record-paths.test.ts）
    expect(record).toMatch(/const ensureDir = \(fs, dir, label, \{ root, create = true \} = \{\}\) => ensureSafeDir\(dir, \{ fs, root, label, create \}\)/);
    expect(record).toMatch(/ensureSafeDir\(dir, \{ fs, root, label: "browser-recordings" \}\)/);
    expect(record).not.toMatch(/fs\.chmodSync\(dir, 0o700\)/);
  });
});
