/**
 * Windows 机器环境取证（electron-app/env-probe.mjs）。
 * ⚠️ 这里只能验证「脚本文本的约束」和「解析」；PowerShell 语义由另一处（pwsh 语法解析）与真机验证。
 */
import { describe, expect, it } from "vitest";

import {
  ENV_PROBE_TIMEOUT_MS,
  buildEnvProbeScript,
  describeEnvProbe,
  driveLetterOf,
  parseEnvProbe,
} from "../electron-app/env-probe.mjs";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("driveLetterOf", () => {
  it("取盘符并大写；UNC / 相对路径 / 空 / 非字符串 → null", () => {
    expect(driveLetterOf("C:\\Users\\x")).toBe("C");
    expect(driveLetterOf("d:/tmp")).toBe("D");
    expect(driveLetterOf("\\\\server\\share")).toBeNull();
    expect(driveLetterOf("relative\\x")).toBeNull();
    expect(driveLetterOf("")).toBeNull();
    expect(driveLetterOf(undefined as unknown as string)).toBeNull();
  });
});

describe("buildEnvProbeScript：脚本文本约束（与杀软清单探测同款）", () => {
  const script = buildEnvProbeScript({ drives: ["C", "d"] });

  it("只含可打印 ASCII、不含双引号（避免 argv 引号转义 / 代码页吃字）", () => {
    expect(script).toMatch(/^[\x20-\x7e]+$/);
    expect(script).not.toContain('"');
  });

  it("没有 `; catch` 这种会让 PowerShell 报孤立语法错误的写法（try 与 catch 必须连在一起）", () => {
    expect(script).not.toMatch(/;\s*catch/);
    // 每个 try 都紧跟一个 catch：try 数 = catch 数
    const tries = script.match(/\btry \{/g)?.length ?? 0;
    const catches = script.match(/\bcatch \{/g)?.length ?? 0;
    expect(tries).toBeGreaterThanOrEqual(6);
    expect(catches).toBe(tries);
  });

  it("花括号 / 圆括号 / 单引号配平（语法层面最容易手滑的三类）", () => {
    const count = (re: RegExp) => script.match(re)?.length ?? 0;
    expect(count(/\{/g)).toBe(count(/\}/g));
    expect(count(/\(/g)).toBe(count(/\)/g));
    expect(count(/'/g) % 2).toBe(0);
  });

  it("每个取证段各自 try/catch（一个 cmdlet 不可用只丢一行），且逐行立即输出（超时被杀仍能拿到已输出的）", () => {
    for (const section of ["defender", "cpu", "machine", "power", "battery", "disk"]) {
      expect(script, section).toContain(`E ('${section}`);
    }
    expect(script).toContain("function E($s)");
    expect(script).toContain("'L:' + [Convert]::ToBase64String");
    // 不是攒到最后一次性输出
    expect(script).not.toMatch(/'OK:'/);
  });

  it("关键取证项：Defender 实时防护 / 盘介质 / 电源计划 / 电池 / CPU 频率", () => {
    expect(script).toContain("Get-MpComputerStatus");
    expect(script).toContain("RealTimeProtectionEnabled");
    expect(script).toContain("Get-PhysicalDisk");
    expect(script).toContain("MediaType");
    expect(script).toContain("powercfg /getactivescheme");
    expect(script).toContain("Win32_Battery");
    expect(script).toContain("CurrentClockSpeed");
    expect(script).toContain("MaxClockSpeed");
  });

  it("全是只读 cmdlet：不含任何会改系统状态的命令", () => {
    for (const verb of ["Set-", "Remove-", "New-Item", "Start-Process", "Stop-", "Restart-", "Invoke-Expression", "iex ", "Add-MpPreference", "Out-File", "Set-Content"]) {
      expect(script, verb).not.toContain(verb);
    }
  });

  it("盘符：去重、大写、只接受单个字母——脚本里会直接嵌进去，不能留注入口", () => {
    expect(buildEnvProbeScript({ drives: ["c", "C", "D"] })).toContain("@('C','D')");
    const evil = buildEnvProbeScript({ drives: ["C');calc;('", "1", "", "CD", "E"] });
    expect(evil).toContain("@('E')");
    expect(evil).not.toContain("calc");
  });

  it("没有盘符 → 空数组（foreach 空转）；盘符数量有上限", () => {
    expect(buildEnvProbeScript({ drives: [] })).toContain("foreach ($d in @())");
    expect(buildEnvProbeScript()).toContain("foreach ($d in @())");
    const many = buildEnvProbeScript({ drives: ["A", "B", "C", "D", "E", "F"] });
    expect(many).toContain("@('A','B','C','D')");
  });

  it("超时常量足够宽（存储管理 CIM 冷启动可能要几秒）、但仍是有限值", () => {
    expect(ENV_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(ENV_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("parseEnvProbe", () => {
  it("逐行解码 L:<base64>；忽略空行 / BOM / 其它杂散输出", () => {
    const out = [
      "\uFEFF",
      `L:${b64("defender av=True rtp=True")}`,
      "noise",
      "",
      `L:${b64("disk C: media=SSD bus=NVMe")}\r`,
    ].join("\r\n");
    const r = parseEnvProbe(null, out);
    expect(r.kind).toBe("ok");
    expect(r.lines).toEqual(["defender av=True rtp=True", "disk C: media=SSD bus=NVMe"]);
  });

  it("中文（如整机型号）按 UTF-8 解码不乱码；控制字符换成空格", () => {
    const r = parseEnvProbe(null, `L:${b64("machine model=联想\u0007天逸")}`);
    expect(r.lines[0]).toBe("machine model=联想 天逸");
  });

  it("超时被杀：已输出的行仍然有效（这是逐行立即输出的意义）", () => {
    const err = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
    const r = parseEnvProbe(err, `L:${b64("cpu cur=800MHz")}`);
    expect(r.kind).toBe("timeout");
    expect(r.lines).toEqual(["cpu cur=800MHz"]);
  });

  it("拉不起 PowerShell / 非零退出：exec-error 带原因（数字码 → exit N；字符串码如 ENOENT 原样）", () => {
    expect(parseEnvProbe(Object.assign(new Error("x"), { code: 1 }), "").detail).toBe("exit 1");
    const r = parseEnvProbe(Object.assign(new Error("x"), { code: "ENOENT" }), "");
    expect(r.kind).toBe("exec-error");
    expect(r.detail).toBe("ENOENT");
  });

  it("没有任何可解析行：unparsable，且杂散输出被清洗 / 截断", () => {
    const r = parseEnvProbe(null, "乱码\u0000output ".repeat(30));
    expect(r.kind).toBe("unparsable");
    expect(r.detail).toMatch(/^[\x20-\x7e]{1,40}$/);
    expect(parseEnvProbe(null, "").detail).toBe("（空输出）");
  });

  it("行数 / 单行长度有上限（输出是数据，不信任）", () => {
    const many = Array.from({ length: 50 }, (_, i) => `L:${b64(`line ${i}`)}`).join("\n");
    expect(parseEnvProbe(null, many).lines).toHaveLength(20);
    const long = parseEnvProbe(null, `L:${b64("x".repeat(5000))}`);
    expect(long.lines[0]).toHaveLength(200);
  });
});

describe("describeEnvProbe：每种结局文案不同，事后分得清「没有」和「没查到」", () => {
  it("ok：只有数据行", () => {
    expect(describeEnvProbe({ kind: "ok", lines: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("timeout / exec-error / unparsable：在已拿到的行后面追加一句说明", () => {
    const t = describeEnvProbe({ kind: "timeout", lines: ["a"] });
    expect(t[0]).toBe("a");
    expect(t[1]).toContain(`${ENV_PROBE_TIMEOUT_MS / 1000}s`);
    expect(t[1]).toContain("1 行");
    expect(describeEnvProbe({ kind: "exec-error", lines: [], detail: "ENOENT" })[0]).toContain("ENOENT");
    expect(describeEnvProbe({ kind: "unparsable", lines: [], detail: "xx" })[0]).toContain("xx");
  });
});
