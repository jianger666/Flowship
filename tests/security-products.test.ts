/**
 * 杀软清单探测（electron-app/security-products.mjs）。
 *
 * 动机（合并前评审 #3）：PowerShell 5.1 的 stdout 被重定向时用 OEM 代码页（简中 = GBK），而 Node 按
 * UTF-8 解码——360 / 火绒 / 腾讯电脑管家的名字会变乱码；另外「超时」与「Server 版没有该命名空间」
 * 原先都记成「（没取到）」，事后分不清。现在 PowerShell 输出 Base64，这里解码并区分各种结局。
 */
import { describe, expect, it } from "vitest";

import {
  SECURITY_PROBE_SCRIPT,
  SECURITY_PROBE_TIMEOUT_MS,
  describeSecurityProbe,
  parseSecurityProbe,
} from "../electron-app/security-products.mjs";

/** 模拟脚本的输出：OK: + Base64(UTF-8 名字列表) */
const okOutput = (names: string[], eol = "\n") =>
  `OK:${Buffer.from(names.join(eol), "utf8").toString("base64")}`;

describe("SECURITY_PROBE_SCRIPT：脚本文本约束", () => {
  it("只含可打印 ASCII、不含双引号 / 反斜杠（argv 引号转义与代码页都碰不到它）", () => {
    expect(SECURITY_PROBE_SCRIPT).toMatch(/^[\x20-\x7e]+$/);
    expect(SECURITY_PROBE_SCRIPT).not.toContain('"');
    expect(SECURITY_PROBE_SCRIPT).not.toContain("\\");
  });

  it("输出 Base64(UTF-8)、不直接打印名字；只读 SecurityCenter2；结局用 OK: / ERR: 前缀区分", () => {
    expect(SECURITY_PROBE_SCRIPT).toContain("root/SecurityCenter2");
    expect(SECURITY_PROBE_SCRIPT).toContain("AntiVirusProduct");
    expect(SECURITY_PROBE_SCRIPT).toContain("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(");
    expect(SECURITY_PROBE_SCRIPT).toContain("'OK:' +");
    expect(SECURITY_PROBE_SCRIPT).toContain("'ERR:' +");
    // 不是只读：不能有任何写 / 改系统状态的 cmdlet
    expect(SECURITY_PROBE_SCRIPT).not.toMatch(/\b(Set|New|Remove|Add|Start|Stop|Invoke)-/);
  });

  it("try / catch 紧挨着：中间多一个分号 PowerShell 就把 catch 当成孤立的语法错误", () => {
    expect(SECURITY_PROBE_SCRIPT).toMatch(/\}\s*catch\s*\{/);
    expect(SECURITY_PROBE_SCRIPT).not.toMatch(/\}\s*;\s*catch/);
    // 查询错误必须变成终止错误才能被 catch 接住
    expect(SECURITY_PROBE_SCRIPT).toContain("$ErrorActionPreference = 'Stop'");
    expect(SECURITY_PROBE_SCRIPT.indexOf("$ErrorActionPreference")).toBeLessThan(
      SECURITY_PROBE_SCRIPT.indexOf("try {"),
    );
  });

  it("超时 10s", () => {
    expect(SECURITY_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("parseSecurityProbe：结局分类", () => {
  it("中文杀软名经 Base64 往返不乱码（这正是评审要求的、不依赖控制台代码页）", () => {
    const names = ["360安全卫士", "火绒安全软件", "腾讯电脑管家", "Windows Defender"];
    expect(parseSecurityProbe(null, okOutput(names))).toEqual({ kind: "ok", names });
  });

  it("CRLF 分隔、BOM、首尾空白、重复项、空行都能处理", () => {
    const out = `\uFEFF  ${okOutput(["火绒", "", "火绒", " 360 "], "\r\n")}\r\n`;
    expect(parseSecurityProbe(null, out)).toEqual({ kind: "ok", names: ["火绒", "360"] });
  });

  it("OK: 后列表为空 → none（安全中心里没登记杀软），不是「没取到」", () => {
    expect(parseSecurityProbe(null, "OK:\r\n")).toEqual({ kind: "none", names: [] });
    expect(parseSecurityProbe(null, okOutput([]))).toEqual({ kind: "none", names: [] });
  });

  it("ERR: → query-error 并带异常类型（Server 版没有 SecurityCenter2 命名空间就是这种）", () => {
    expect(parseSecurityProbe(null, "ERR:CimException\r\n")).toEqual({
      kind: "query-error",
      names: [],
      detail: "CimException",
    });
  });

  it("ERR: 后面的内容清洗并截断：只留可打印 ASCII、不超过 60 字符（日志里不混乱码 / 超长内容）", () => {
    const r = parseSecurityProbe(null, `ERR:${"E".repeat(200)}`);
    expect(r.kind).toBe("query-error");
    expect(r.detail).toBe("E".repeat(60));
    expect(parseSecurityProbe(null, "ERR:访问被拒绝").detail).toBe("?????");
  });

  it("execFile 超时（killed / signal）→ timeout，与查询失败分开", () => {
    const timedOut = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    expect(parseSecurityProbe(timedOut, "")).toEqual({ kind: "timeout", names: [] });
    expect(parseSecurityProbe(Object.assign(new Error("x"), { signal: "SIGKILL" }), "").kind).toBe("timeout");
  });

  it("只有 killed、没有 signal 也算超时（Windows 上 TerminateProcess 不一定带信号名；killed 是 Node 自己置的、最可靠）", () => {
    // 同时带非零退出码：必须先认 killed、不能落进 exec-error 把「超时」说成「PowerShell 拉不起来」
    const err = Object.assign(new Error("x"), { killed: true, signal: null, code: 1 });
    expect(parseSecurityProbe(err, "")).toEqual({ kind: "timeout", names: [] });
  });

  it("拉不起 PowerShell（ENOENT）/ 非零退出码 → exec-error 并带原因", () => {
    expect(parseSecurityProbe(Object.assign(new Error("spawn"), { code: "ENOENT" }), "")).toEqual({
      kind: "exec-error",
      names: [],
      detail: "ENOENT",
    });
    expect(parseSecurityProbe(Object.assign(new Error("x"), { code: 1 }), "")).toEqual({
      kind: "exec-error",
      names: [],
      detail: "exit 1",
    });
  });

  it("既不是 OK: 也不是 ERR:（杂散输出 / 空输出）→ unparsable，原文清洗后截断再进日志", () => {
    expect(parseSecurityProbe(null, "").kind).toBe("unparsable");
    expect(parseSecurityProbe(null, undefined).kind).toBe("unparsable");
    const r = parseSecurityProbe(null, `警告：${"x".repeat(200)}`);
    expect(r.kind).toBe("unparsable");
    // 非 ASCII 清洗成 ?、长度截断：日志里不会混进乱码或超长内容
    expect(r.detail).toMatch(/^[\x20-\x7e]{1,40}$/);
    expect(r.detail).toContain("?");
  });

  it("stdout 是 Buffer 也能解析", () => {
    expect(parseSecurityProbe(null, Buffer.from(okOutput(["火绒"]), "utf8"))).toEqual({
      kind: "ok",
      names: ["火绒"],
    });
  });
});

describe("describeSecurityProbe：每种结局的日志文案互不相同（事后才分得清为什么没有清单）", () => {
  it("ok → 顿号连接的名单", () => {
    expect(describeSecurityProbe({ kind: "ok", names: ["火绒", "Windows Defender"] })).toBe(
      "火绒、Windows Defender",
    );
  });

  it("其余结局各有关键词，且不会都是「没取到」", () => {
    const texts = {
      none: describeSecurityProbe({ kind: "none", names: [] }),
      timeout: describeSecurityProbe({ kind: "timeout", names: [] }),
      queryError: describeSecurityProbe({ kind: "query-error", names: [], detail: "CimException" }),
      execError: describeSecurityProbe({ kind: "exec-error", names: [], detail: "ENOENT" }),
      unparsable: describeSecurityProbe({ kind: "unparsable", names: [], detail: "abc" }),
    };
    expect(texts.none).toContain("没有登记");
    expect(texts.timeout).toContain("10s");
    expect(texts.queryError).toContain("CimException");
    expect(texts.queryError).toContain("Server");
    expect(texts.execError).toContain("ENOENT");
    expect(texts.unparsable).toContain("abc");
    expect(new Set(Object.values(texts)).size).toBe(5);
    for (const t of Object.values(texts)) expect(t).not.toContain("没取到");
  });
});
