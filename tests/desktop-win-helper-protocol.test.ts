/**
 * Windows 解锁组件（electron-app/desktop/win-helper/）的协议、源码、安装脚本三方对账。
 *
 * 背景：组件的同一份约定写在三处——protocol.mjs（Flowship 主进程侧）、assets/FlowshipUnlockHelper.cs（以 SYSTEM 身份运行）、
 * assets/install.ps1 / uninstall.ps1（以管理员身份运行）。这些代码只能在真 Windows 上跑，这台机器上没法端到端验证，
 * 所以这里把「两边必须一致」的每一项都变成静态对账：版本 / 限制 / 键表 / 动词 / 结果码 / 路径 / 退出码 / 资源哈希，
 * 以及几条写进 C# 头部的硬规矩（只用 C# 5 语法、日志里不出现密码）。任何一边改了没同步，这里直接红。
 *
 * 不在这里验证：真的在 Windows 上编译 / 安装 / 解锁（要同事实机测，清单在 docs/windows-unlock-live-test.md）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UNLOCK_TIMEOUT_MS } from "../electron-app/desktop/win-helper/client.mjs";
import {
  ADMIN_EXIT,
  ASSET_FILES,
  BOOTSTRAP_ONLY_EXITS,
  COOLDOWN_SECONDS,
  EXE_NAME,
  HELPER_ASSET_SHA256,
  HELPER_VERSION,
  KEY_CHARS,
  KEY_VKS,
  MAX_LINE_BYTES,
  MAX_PASSWORD_LENGTH,
  NOT_TYPEABLE_HINT,
  PROTOCOL_TAG,
  PROTOCOL_VERSION,
  RESPONSE_CODES,
  SHIFT_CHARS,
  TASK_FOLDER,
  TASK_NAME,
  VERBS,
  assetSha256,
  describeAdminExit,
  describePasswordProblem,
  describeSetFailure,
  encodeRequest,
  helperPaths,
  normalizeAssetBytes,
  parseResponse,
  parseStatusFields,
  passwordProblem,
  responseText,
  unlockResultFromResponse,
} from "../electron-app/desktop/win-helper/protocol.mjs";
import { SID_RE } from "../electron-app/desktop/win-helper/installer.mjs";
import {
  CSHARP5_LEGAL_SAMPLES,
  CSHARP5_RULES,
  CSHARP5_VIOLATION_SAMPLES,
  csharp5Violations,
} from "./helpers/csharp5-gate";
import {
  WTSINFOEX_OFFSETS,
  WTSINFOEX_READ_BYTES,
  WTS_CURRENT_SESSION,
  WTS_SESSION_INFO_EX,
} from "../electron-app/desktop/drivers/win32-defs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "electron-app", "desktop", "win-helper", "assets");
const read = (name: string): string => fs.readFileSync(path.join(ASSETS, name), "utf8");
const CS = read(ASSET_FILES.source);
const INSTALL_PS1 = read(ASSET_FILES.install);
const UNINSTALL_PS1 = read(ASSET_FILES.uninstall);

// ───────────────────────── 从 C# 源码里取值 ─────────────────────────

const csInt = (name: string): number => {
  const m = new RegExp(`const int ${name} = (\\d+);`).exec(CS);
  if (!m) throw new Error(`C# 里找不到 const int ${name}`);
  return Number(m[1]);
};

/** C# 普通字符串字面量的反转义（这几张表里只会出现 \\ 和 \"，别的转义说明表被改成了这里没覆盖的写法 → 直接报错） */
const unescapeCs = (literal: string): string =>
  literal.replace(/\\(.)/g, (_all, ch: string) => {
    if (ch === "\\" || ch === '"') return ch;
    throw new Error(`C# 字符串里出现了没覆盖的转义 \\${ch}`);
  });

const csString = (name: string): string => {
  const m = new RegExp(`const string ${name} = "((?:[^"\\\\]|\\\\.)*)";`).exec(CS);
  if (!m) throw new Error(`C# 里找不到 const string ${name}`);
  return unescapeCs(m[1]);
};

const csKeyVks = (): number[] => {
  const m = /KeyVks = new byte\[\]\s*\{([^}]*)\}/.exec(CS);
  if (!m) throw new Error("C# 里找不到 KeyVks");
  return [...m[1].matchAll(/0x([0-9A-Fa-f]{2})/g)].map((x) => parseInt(x[1], 16));
};

const csRespondCodes = (): string[] => [...new Set([...CS.matchAll(/Respond\(\s*\w+\s*,\s*(?:true|false)\s*,\s*"([A-Z_]+)"/g)].map((m) => m[1]))].sort();

/**
 * 去掉 C# 源码里的注释、字符串内容、字符字面量（引号留着、内容抹掉），剩下纯代码，用来做语法特征检查。
 * 够用就好：覆盖 // 和 /* *​/ 注释、普通字符串、@"" 逐字字符串、字符字面量；没有处理预处理指令（源码里没用到）。
 */
const stripCSharp = (src: string): string => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "@" && next === '"') {
      i += 2;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/** 脚本里所有 `Fail <数字>` 调用的退出码（函数定义 `function Fail([int]$Code` 不匹配） */
const failCodes = (script: string): number[] => [...script.matchAll(/\bFail\s+(\d+)\b/g)].map((m) => Number(m[1]));

// ───────────────────────── 常量 / 限制 ─────────────────────────

describe("版本、协议、限制：和 C# Const 一致", () => {
  it("版本号 / 协议号 / 标记 / 行长 / 密码长度 / 冷却秒数逐项相等", () => {
    expect(csInt("Version")).toBe(HELPER_VERSION);
    expect(csInt("Proto")).toBe(PROTOCOL_VERSION);
    expect(csString("Tag")).toBe(PROTOCOL_TAG);
    expect(csInt("MaxLine")).toBe(MAX_LINE_BYTES);
    expect(csInt("MaxPasswordLength")).toBe(MAX_PASSWORD_LENGTH);
    expect(csInt("CooldownSeconds")).toBe(COOLDOWN_SECONDS);
  });

  it("v3 下限：DoSet「清不掉但已过期不再误报」改的是 service 运行行为，版本不能退回 v2；Proto 的 doc 注释写着 v3 的含义", () => {
    // 对账测试只比两边一致，不替人判断该不该升；这条钉住「这一处行为变化已经升过版」
    expect(HELPER_VERSION).toBeGreaterThanOrEqual(3);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
    expect(CS).toContain("v3：DoSet 只在冷却确实还在时才回 COOLDOWN_NOT_CLEARED");
  });

  it("v4 下限：凭据「有没有」不再用 File.Exists 改的是 service / typist 运行行为，版本不能退回 v3；Const 的 doc 注释写着 v4 的含义（第六轮评审 P2-3）", () => {
    expect(HELPER_VERSION).toBeGreaterThanOrEqual(4);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
    expect(CS).toContain("v4：凭据「有没有」（CredStore.Exists / Load / Save）不再用 File.Exists");
  });

  it("超时链：typist < 连接看门狗 < Flowship 客户端的 unlock 超时（组件先给结论，客户端不抢在它前面放弃）", () => {
    expect(csInt("TypistTimeoutMs")).toBeLessThan(csInt("ClientTimeoutMs"));
    expect(csInt("ClientTimeoutMs")).toBeLessThan(UNLOCK_TIMEOUT_MS);
  });

  it("最长的 set 请求（每个字符都要百分号编码）也远小于组件的单行上限", () => {
    const worst = encodeRequest("set", { pw: '"'.repeat(MAX_PASSWORD_LENGTH) });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_LINE_BYTES);
  });

  it("动词：和 C# HandleClient 的 switch 一一对应", () => {
    const csVerbs = [...CS.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect([...csVerbs].sort()).toEqual([...VERBS].sort());
  });

  it("线路格式：C# 的 Respond 按「FS1 TAB ok|err TAB code=… TAB 键=百分号编码值」拼装，请求值用 UnescapeDataString 解", () => {
    expect(CS).toContain('Append(Const.Tag).Append(\'\\t\').Append(ok ? "ok" : "err")');
    expect(CS).toContain('Append("code=")');
    expect(CS).toContain("Uri.EscapeDataString(");
    expect(CS).toContain("Uri.UnescapeDataString(");
  });
});

// ───────────────────────── 键表 ─────────────────────────

describe("键表：和 C# Keymap 逐项一致，且符合美式键盘的真实布局", () => {
  it("三张表（字符 / Shift 字符 / 虚拟键码）与 C# 完全相同", () => {
    expect(csString("KeyChars")).toBe(KEY_CHARS);
    expect(csString("ShiftChars")).toBe(SHIFT_CHARS);
    expect(csKeyVks()).toEqual([...KEY_VKS]);
  });

  it("三张表等长（48 个键）", () => {
    expect(KEY_CHARS.length).toBe(48);
    expect(SHIFT_CHARS.length).toBe(48);
    expect(KEY_VKS.length).toBe(48);
  });

  it("独立的美式键盘事实表：每个键的 VK 和 Shift 字符都对（防止两边一起错位）", () => {
    const layout: Record<string, { vk: number; shifted: string }> = {};
    for (let i = 0; i < 26; i++) layout[String.fromCharCode(97 + i)] = { vk: 0x41 + i, shifted: String.fromCharCode(65 + i) };
    const digitShift = ")!@#$%^&*(";
    for (let i = 0; i < 10; i++) layout[String(i)] = { vk: 0x30 + i, shifted: digitShift[i] };
    Object.assign(layout, {
      " ": { vk: 0x20, shifted: " " },
      ";": { vk: 0xba, shifted: ":" },
      "=": { vk: 0xbb, shifted: "+" },
      ",": { vk: 0xbc, shifted: "<" },
      "-": { vk: 0xbd, shifted: "_" },
      ".": { vk: 0xbe, shifted: ">" },
      "/": { vk: 0xbf, shifted: "?" },
      "`": { vk: 0xc0, shifted: "~" },
      "[": { vk: 0xdb, shifted: "{" },
      "\\": { vk: 0xdc, shifted: "|" },
      "]": { vk: 0xdd, shifted: "}" },
      "'": { vk: 0xde, shifted: '"' },
    });
    expect(Object.keys(layout).length).toBe(KEY_CHARS.length);
    for (let i = 0; i < KEY_CHARS.length; i++) {
      const expected = layout[KEY_CHARS[i]];
      expect(expected, `键表里多出了字符 ${JSON.stringify(KEY_CHARS[i])}`).toBeDefined();
      expect(KEY_VKS[i], `字符 ${JSON.stringify(KEY_CHARS[i])} 的虚拟键码`).toBe(expected.vk);
      expect(SHIFT_CHARS[i], `字符 ${JSON.stringify(KEY_CHARS[i])} 的 Shift 字符`).toBe(expected.shifted);
    }
  });

  it("没有两个字符映射到同一个「键 + Shift」组合（否则其中一个永远输不对）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < KEY_CHARS.length; i++) {
      for (const [ch, shift] of [[KEY_CHARS[i], false], [SHIFT_CHARS[i], true]] as const) {
        if (shift && ch === KEY_CHARS[i]) continue; // 空格：Shift 版和原版是同一个字符，不算重复
        expect(seen.has(ch), `字符 ${JSON.stringify(ch)} 重复出现`).toBe(false);
        seen.add(ch);
      }
    }
  });
});

describe("passwordProblem：开机密码在锁屏界面打不打得出来", () => {
  it("键表里的每个字符（含 Shift 字符）都打得出来", () => {
    for (const ch of KEY_CHARS + SHIFT_CHARS) expect(passwordProblem(ch), JSON.stringify(ch)).toBeNull();
  });

  it("典型密码：字母数字符号、含空格", () => {
    for (const pw of ["P@ssw0rd!2024", "my pass phrase 123", "a", "~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./"]) {
      expect(passwordProblem(pw), pw).toBeNull();
    }
  });

  it("长度边界：127 个字符可以，128 个太长", () => {
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe("too_long");
  });

  it("空 / 不是字符串：empty", () => {
    for (const bad of ["", null, undefined, 123, {}, []]) expect(passwordProblem(bad), String(bad)).toBe("empty");
  });

  it("中文 / 带音标字母 / emoji（代理对）/ 制表符 / 换行 / 零宽字符：打不出来", () => {
    for (const bad of ["密码", "passé", "😀", "tab\there", "line\nbreak", "zero\u200bwidth", "pass\r"]) {
      expect(passwordProblem(bad), JSON.stringify(bad)).toBe("untypeable");
    }
  });

  it("三种问题各有说明；打不出来的那条带上「只能输入英文字母、数字和常见符号」", () => {
    expect(describePasswordProblem("empty")).toContain("不能为空");
    expect(describePasswordProblem("too_long")).toContain(String(MAX_PASSWORD_LENGTH));
    const untypeable = describePasswordProblem("untypeable");
    expect(untypeable).toContain(NOT_TYPEABLE_HINT);
    expect(untypeable).toContain("没有保存");
  });
});

// ───────────────────────── 线路编解码 ─────────────────────────

describe("encodeRequest", () => {
  it("无字段：标记 + 动词 + LF", () => {
    expect(encodeRequest("ping")).toBe("FS1\tping\n");
    for (const verb of VERBS) expect(encodeRequest(verb)).toBe(`FS1\t${verb}\n`);
  });

  it("字段值百分号编码", () => {
    expect(encodeRequest("set", { pw: "a b" })).toBe("FS1\tset\tpw=a%20b\n");
  });

  it("值里的制表符 / 换行 / 回车 / 等号 / 百分号 / 中文都被编掉：整条请求恰好一行、字段数不变，且能原样解回来", () => {
    const nasty = "a\tb\nc\rd=e%f 中文😀\"'";
    const line = encodeRequest("set", { pw: nasty });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\n\r]/);
    const parts = line.slice(0, -1).split("\t");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("FS1");
    expect(parts[1]).toBe("set");
    const eq = parts[2].indexOf("=");
    expect(parts[2].slice(0, eq)).toBe("pw");
    expect(decodeURIComponent(parts[2].slice(eq + 1))).toBe(nasty);
  });

  it("未知动词、非法字段名直接抛（代码 bug，不带出字段值）", () => {
    expect(() => encodeRequest("format-disk")).toThrow(/未知的组件动词/);
    expect(() => encodeRequest("set", { PW: "x" })).toThrow(/非法的字段名/);
    expect(() => encodeRequest("set", { "p w": "x" })).toThrow(/非法的字段名/);
    expect(() => encodeRequest("set", { pw1: "x" })).toThrow(/非法的字段名/);
    expect(() => encodeRequest("set", { "": "x" })).toThrow(/非法的字段名/);
    try {
      encodeRequest("set", { PW: "TOP-SECRET-VALUE" });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("TOP-SECRET-VALUE");
    }
  });
});

describe("parseResponse", () => {
  it("成功 / 失败；code 从字段里取出来、不留在 fields 里", () => {
    expect(parseResponse("FS1\tok\tcode=PONG\tproto=1\tver=1\n")).toEqual({ ok: true, code: "PONG", fields: { proto: "1", ver: "1" } });
    expect(parseResponse("FS1\terr\tcode=DENIED\n")).toEqual({ ok: false, code: "DENIED", fields: {} });
  });

  it("接受 CRLF 结尾和没有结尾", () => {
    expect(parseResponse("FS1\tok\tcode=OK\r\n")?.code).toBe("OK");
    expect(parseResponse("FS1\tok\tcode=OK")?.code).toBe("OK");
  });

  it("字段值按百分号解码（制表符 / 中文 / 等号）", () => {
    const r = parseResponse("FS1\terr\tcode=LAUNCH_FAILED\tattempted=0\tdetail=a%20b%09c%E4%B8%AD%3Dd\n");
    expect(r?.fields).toEqual({ attempted: "0", detail: "a b\tc中=d" });
  });

  it("格式不对一律返回 null", () => {
    const bad = [
      "",
      "\n",
      "FS2\tok\tcode=X",
      "FS1\tmaybe\tcode=X",
      "FS1\tok",
      "FS1\tok\tcode",
      "FS1\tok\t=x",
      "FS1\tok\tcode=%E0%A4%A",
      "FS1\tok\tcode=",
      "FS1\tok\tproto=1",
      "hello world",
    ];
    for (const line of bad) expect(parseResponse(line), JSON.stringify(line)).toBeNull();
    expect(parseResponse(null as never)).toBeNull();
    expect(parseResponse(undefined as never)).toBeNull();
  });
});

describe("parseStatusFields", () => {
  const good = { proto: "1", ver: "1", has: "1", cool: "0", console: "1", client: "1" };

  it("正常", () => {
    expect(parseStatusFields(good)).toEqual({ proto: 1, ver: 1, hasCredential: true, cooldownSeconds: 0, consoleSession: 1, clientSession: 1 });
    expect(parseStatusFields({ ...good, has: "0", cool: "587" })).toMatchObject({ hasCredential: false, cooldownSeconds: 587 });
  });

  it("缺任何一项 / 不是数字 / has 不是 0 或 1 / 数字过长：null", () => {
    for (const key of Object.keys(good)) {
      const copy: Record<string, string> = { ...good };
      delete copy[key];
      expect(parseStatusFields(copy), `缺 ${key}`).toBeNull();
    }
    expect(parseStatusFields({ ...good, ver: "abc" })).toBeNull();
    expect(parseStatusFields({ ...good, cool: "-1" })).toBeNull();
    expect(parseStatusFields({ ...good, has: "2" })).toBeNull();
    expect(parseStatusFields({ ...good, has: "true" })).toBeNull();
    expect(parseStatusFields({ ...good, console: "12345678901" })).toBeNull();
  });
});

// ───────────────────────── 结果码 ─────────────────────────

describe("结果码：C# 的每个 Respond 都有中文文案，每条文案都有 C# 在用", () => {
  it("集合完全相等（不留死文案，也不会有「组件回了 Flowship 不认识的码」）", () => {
    expect(Object.keys(RESPONSE_CODES).sort()).toEqual(csRespondCodes());
  });

  it("每条文案都是非空中文说明", () => {
    for (const [code, text] of Object.entries(RESPONSE_CODES)) {
      expect(text.trim().length, code).toBeGreaterThan(0);
      expect(text, code).toMatch(/[\u4e00-\u9fa5]/);
      expect(text, code).not.toMatch(/undefined|null|\[object/);
    }
  });

  it("STILL_LOCKED 说明了 PIN / Windows Hello 这个最常见的原因", () => {
    expect(RESPONSE_CODES.STILL_LOCKED).toMatch(/PIN/);
    expect(RESPONSE_CODES.STILL_LOCKED).toMatch(/Windows Hello/);
  });
});

describe("unlockResultFromResponse：把 unlock 响应翻译成解锁器契约", () => {
  const resp = (ok: boolean, code: string, fields: Record<string, string> = {}) => ({ ok, code, fields });

  it("UNLOCKED → 成功，且一定试过", () => {
    expect(unlockResultFromResponse(resp(true, "UNLOCKED", { attempted: "1" }))).toEqual({ ok: true, attempted: true });
  });

  it("NOT_LOCKED → USER_PRESENT（和 macOS 同一个语义：用户自己解开了），没输过密码", () => {
    expect(unlockResultFromResponse(resp(false, "NOT_LOCKED", { attempted: "0" }))).toMatchObject({ ok: false, code: "USER_PRESENT", attempted: false });
  });

  it("attempted 字段决定「要不要进冷却」：没输过的失败是 false，输过的是 true", () => {
    for (const code of ["NO_CONSOLE_SESSION", "NOT_CONSOLE_CLIENT", "COOLDOWN", "NO_CREDENTIAL", "LAUNCH_FAILED", "NOT_TYPEABLE", "CRED_UNREADABLE", "DESKTOP_ERROR"]) {
      expect(unlockResultFromResponse(resp(false, code, { attempted: "0" })), code).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    }
    for (const code of ["STILL_LOCKED", "TIMEOUT", "INPUT_FAILED", "INTERNAL"]) {
      expect(unlockResultFromResponse(resp(false, code, { attempted: "1" })), code).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    }
  });

  it("响应里没有 attempted 字段：宁可按「试过」处理（多进一次冷却，也不多输一次密码）", () => {
    expect(unlockResultFromResponse(resp(false, "INTERNAL")).attempted).toBe(true);
    expect(unlockResultFromResponse(resp(false, "SOMETHING_NEW")).attempted).toBe(true);
  });

  it("COOLDOWN：带 wait 时给出分钟数（向上取整、至少 1 分钟）", () => {
    expect(unlockResultFromResponse(resp(false, "COOLDOWN", { attempted: "0", wait: "301" })).error).toContain("约 6 分钟");
    expect(unlockResultFromResponse(resp(false, "COOLDOWN", { attempted: "0", wait: "5" })).error).toContain("约 1 分钟");
    expect(unlockResultFromResponse(resp(false, "COOLDOWN", { attempted: "0", wait: "abc" })).error).toBe(RESPONSE_CODES.COOLDOWN);
    expect(unlockResultFromResponse(resp(false, "COOLDOWN", { attempted: "0" })).error).toBe(RESPONSE_CODES.COOLDOWN);
  });

  it("LAUNCH_FAILED / INTERNAL 带 detail 时附上（截断到 120 字符）", () => {
    const detail = "x".repeat(500);
    const launch = unlockResultFromResponse(resp(false, "LAUNCH_FAILED", { attempted: "0", detail }));
    expect(launch.error).toContain("x".repeat(120));
    expect(launch.error).not.toContain("x".repeat(121));
    expect(unlockResultFromResponse(resp(false, "INTERNAL", { attempted: "1", detail: "typist 退出码 99" })).error).toContain("typist 退出码 99");
  });

  it("不认识的结果码：说明里带上它（截断），按失败处理", () => {
    const r = unlockResultFromResponse(resp(false, "WEIRD_CODE", { attempted: "0" }));
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("WEIRD_CODE");
  });

  it("ok 但不是 UNLOCKED：不当成成功", () => {
    expect(unlockResultFromResponse(resp(true, "OK", { attempted: "1" }))).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
  });

  it("SECURE_DESKTOP（屏幕上是 UAC 之类的安全提示）→ 契约码 SECURE_DESKTOP，会话据此交还用户；没输过密码；说明讲清「不是锁屏、什么都没输」", () => {
    const r = unlockResultFromResponse(resp(false, "SECURE_DESKTOP", { attempted: "0" }));
    expect(r).toMatchObject({ ok: false, code: "SECURE_DESKTOP", attempted: false });
    expect(r.error).toBe(RESPONSE_CODES.SECURE_DESKTOP);
    expect(r.error).toMatch(/UAC/);
    expect(r.error).toMatch(/不是锁屏/);
    expect(r.error).toMatch(/没有往里输入任何东西/);
  });

  it("响应码是对象原型上的名字（constructor / __proto__ / toString / hasOwnProperty / valueOf）：当作不认识的码，一律 UNLOCK_FAILED，不会被误认成别的契约码", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const r = unlockResultFromResponse(resp(false, code, { attempted: "0" }));
      expect(r, code).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
      // 文案也不能是顺着原型链取到的函数（第三轮评审顺手发现：RESPONSE_CODES["constructor"] 是 Object 函数）
      expect(typeof r.error, code).toBe("string");
      expect(r.error, code).toContain("不认识的结果码");
      expect(responseText(code), code).toBeUndefined();
    }
  });

  it("只有 NOT_LOCKED 和 SECURE_DESKTOP 两个失败码有专属的契约码，其余一律 UNLOCK_FAILED", () => {
    const special = new Map<string, string>([
      ["NOT_LOCKED", "USER_PRESENT"],
      ["SECURE_DESKTOP", "SECURE_DESKTOP"],
    ]);
    for (const code of Object.keys(RESPONSE_CODES)) {
      if (code === "UNLOCKED") continue;
      expect(unlockResultFromResponse(resp(false, code, { attempted: "0" })).code, code).toBe(special.get(code) ?? "UNLOCK_FAILED");
    }
  });

  it("所有已知结果码都能翻译出文案", () => {
    for (const code of Object.keys(RESPONSE_CODES)) {
      if (code === "UNLOCKED") continue;
      const r = unlockResultFromResponse(resp(false, code, { attempted: "0" }));
      expect(r.error, code).toBeTruthy();
      expect(r.error, code).not.toContain("不认识的结果码");
    }
  });
});

describe("describeSetFailure：保存开机密码失败时给用户看的文案", () => {
  const resp = (code: string, fields: Record<string, string> = {}) => ({ code, fields });

  it("COOLDOWN_NOT_CLEARED：先说清「密码已经保存好」（不是没存上），带 wait 时给出分钟数（向上取整、至少 1 分钟）", () => {
    expect(RESPONSE_CODES.COOLDOWN_NOT_CLEARED).toContain("已经保存好");
    expect(describeSetFailure(resp("COOLDOWN_NOT_CLEARED", { saved: "1", wait: "301" }), "兜底")).toContain("约 6 分钟");
    expect(describeSetFailure(resp("COOLDOWN_NOT_CLEARED", { saved: "1", wait: "5" }), "兜底")).toContain("约 1 分钟");
    expect(describeSetFailure(resp("COOLDOWN_NOT_CLEARED", { saved: "1", wait: "301" }), "兜底")).toContain(RESPONSE_CODES.COOLDOWN_NOT_CLEARED);
  });

  it("COOLDOWN_NOT_CLEARED 没带 wait / wait 不是正数：只给基础文案", () => {
    for (const wait of [undefined, "abc", "0", "-3", ""]) {
      const fields: Record<string, string> = { saved: "1" };
      if (wait !== undefined) fields.wait = wait;
      expect(describeSetFailure(resp("COOLDOWN_NOT_CLEARED", fields), "兜底"), String(wait)).toBe(RESPONSE_CODES.COOLDOWN_NOT_CLEARED);
    }
  });

  it("其它码照 RESPONSE_CODES 的文案；不认识的码（包括对象原型上的名字）用兜底", () => {
    expect(describeSetFailure(resp("STORE_FAILED"), "兜底")).toBe(RESPONSE_CODES.STORE_FAILED);
    expect(describeSetFailure(resp("WEIRD"), "兜底")).toBe("兜底");
    // RESPONSE_CODES 是 Object.freeze 的普通对象：原型链上的名字不能被当成命中
    for (const code of ["constructor", "toString", "hasOwnProperty"]) {
      expect(typeof describeSetFailure(resp(code), "兜底"), code).toBe("string");
    }
  });
});

// ───────────────────────── 路径 / 名称 ─────────────────────────

describe("安装位置与名称：protocol.mjs、C#、两个脚本一致", () => {
  it("helperPaths：程序在 Program Files、数据在 ProgramData\\Flowship\\unlock、public 子目录放管道名和日志", () => {
    expect(helperPaths({ ProgramData: "C:\\ProgramData", ProgramW6432: "C:\\Program Files" })).toEqual({
      dataDir: "C:\\ProgramData\\Flowship\\unlock",
      pubDir: "C:\\ProgramData\\Flowship\\unlock\\public",
      pipeFile: "C:\\ProgramData\\Flowship\\unlock\\public\\pipe.txt",
      helperLog: "C:\\ProgramData\\Flowship\\unlock\\public\\helper.log",
      installLog: "C:\\ProgramData\\Flowship\\unlock\\public\\install.log",
      installDir: "C:\\Program Files\\Flowship\\unlock",
      exe: "C:\\Program Files\\Flowship\\unlock\\FlowshipUnlockHelper.exe",
    });
  });

  it("环境变量的回退顺序：ProgramData → ALLUSERSPROFILE → 默认值；ProgramW6432（32 位进程里也指向 64 位目录）优先于 ProgramFiles", () => {
    expect(helperPaths({ ALLUSERSPROFILE: "D:\\AllUsers" }).dataDir).toBe("D:\\AllUsers\\Flowship\\unlock");
    expect(helperPaths({}).dataDir).toBe("C:\\ProgramData\\Flowship\\unlock");
    expect(helperPaths({ ProgramFiles: "D:\\PF" }).installDir).toBe("D:\\PF\\Flowship\\unlock");
    expect(helperPaths({ ProgramFiles: "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files" }).installDir).toBe("C:\\Program Files\\Flowship\\unlock");
    expect(helperPaths({}).installDir).toBe("C:\\Program Files\\Flowship\\unlock");
  });

  it("C# 的 Paths 用同样的目录和文件名", () => {
    expect(CS).toContain('"Flowship\\\\unlock"'); // C# 字面量里的 Flowship\unlock
    for (const literal of ['"public"', '"pipe.txt"', '"helper.log"', '"config.txt"', '"cred.bin"', '"state.txt"']) expect(CS, literal).toContain(literal);
    expect(helperPaths().pipeFile.endsWith("\\public\\pipe.txt")).toBe(true);
    expect(helperPaths().helperLog.endsWith("\\public\\helper.log")).toBe(true);
  });

  it("install.ps1 用同样的目录布局和文件名", () => {
    expect(INSTALL_PS1).toContain("Join-Path $programFiles 'Flowship\\unlock'");
    expect(INSTALL_PS1).toContain("Join-Path $programData 'Flowship\\unlock'");
    for (const literal of ["'public'", "'pipe.txt'", "'install.log'", "'config.txt'"]) expect(INSTALL_PS1, literal).toContain(literal);
    expect(INSTALL_PS1).toContain(`'${EXE_NAME}'`);
  });

  it("两个脚本里的计划任务名 / 文件夹 / 进程名和 protocol.mjs 一致", () => {
    const processName = EXE_NAME.replace(/\.exe$/, "");
    for (const [name, script] of [["install.ps1", INSTALL_PS1], ["uninstall.ps1", UNINSTALL_PS1]] as const) {
      expect(script, name).toContain(`$taskName = '${TASK_NAME}'`);
      expect(script, name).toContain(`$taskPath = '${TASK_FOLDER}'`);
      expect(script, name).toContain(`'${processName}'`);
      expect(script, name).toContain("Join-Path $programFiles 'Flowship\\unlock'");
      expect(script, name).toContain("Join-Path $programData 'Flowship\\unlock'");
    }
  });

  it("账户 SID 的校验规则：install.ps1 和 installer.mjs 是同一条正则（脚本里末尾用 \\z、区分大小写，见 install.ps1 的注释）", () => {
    expect(INSTALL_PS1).toContain(`$Sid -cnotmatch '${SID_RE.source.replace(/\$$/, "\\z")}'`);
  });
});

// ───────────────────────── 管理员脚本的退出码 ─────────────────────────

describe("管理员脚本退出码：脚本里的每个 Fail N 都在 ADMIN_EXIT 里，ADMIN_EXIT 里的每个码也真的有脚本会用", () => {
  const installCodes = failCodes(INSTALL_PS1);
  const uninstallCodes = failCodes(UNINSTALL_PS1);
  const known = new Set<number>(Object.values(ADMIN_EXIT));

  it("脚本里确实能扫到 Fail 调用（正则没失效）", () => {
    expect(installCodes.length).toBeGreaterThan(8);
    expect(uninstallCodes.length).toBeGreaterThanOrEqual(3);
  });

  it("脚本用到的退出码都登记过", () => {
    for (const code of [...installCodes, ...uninstallCodes]) expect(known.has(code), `脚本里出现了没登记的退出码 ${code}`).toBe(true);
  });

  it("install.ps1 只用安装相关的码，uninstall.ps1 只用卸载相关的码（别串）", () => {
    const installSet = new Set<number>([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 91, 92, 93]);
    const uninstallSet = new Set<number>([31, 32, 91]);
    for (const code of installCodes) expect(installSet.has(code), `install.ps1 的 ${code}`).toBe(true);
    for (const code of uninstallCodes) expect(uninstallSet.has(code), `uninstall.ps1 的 ${code}`).toBe(true);
  });

  it("除了「外层 / 引导」才会产生的几个码，ADMIN_EXIT 里每个码都有脚本在用（不留死码）", () => {
    const used = new Set<number>([...installCodes, ...uninstallCodes]);
    for (const code of known) {
      if ((BOOTSTRAP_ONLY_EXITS as readonly number[]).includes(code)) continue;
      expect(used.has(code), `退出码 ${code} 没有任何脚本用到`).toBe(true);
    }
  });

  it("每个码都有专属说明（不会落到兜底句式）；所有码互不重复", () => {
    const values = Object.values(ADMIN_EXIT);
    expect(new Set(values).size).toBe(values.length);
    const fallback = describeAdminExit(987654).replace("987654", "");
    for (const [name, code] of Object.entries(ADMIN_EXIT)) {
      if (code === ADMIN_EXIT.OK) continue;
      expect(describeAdminExit(code), name).not.toContain(fallback);
      expect(describeAdminExit(code), name).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it("没拿到退出码 / 不认识的退出码：如实说", () => {
    expect(describeAdminExit(null)).toContain("中断");
    expect(describeAdminExit(12345)).toContain("12345");
    expect(describeAdminExit(12345)).toContain("意料之外");
  });

  it("两个脚本都以 exit 0 收尾，并且先检查管理员身份", () => {
    for (const [name, script] of [["install.ps1", INSTALL_PS1], ["uninstall.ps1", UNINSTALL_PS1]] as const) {
      expect(script.trimEnd().endsWith("exit 0"), name).toBe(true);
      expect(script, name).toContain("Fail 91");
      expect(script.indexOf("Fail 91"), name).toBeLessThan(script.indexOf("Get-ScheduledTask"));
    }
  });
});

// ───────────────────────── 资源哈希 ─────────────────────────

describe("资源文件哈希", () => {
  for (const name of Object.values(ASSET_FILES)) {
    it(`${name}：protocol.mjs 里登记的哈希和磁盘上的文件一致，不是占位的全零`, () => {
      const expected = HELPER_ASSET_SHA256[name as keyof typeof HELPER_ASSET_SHA256];
      expect(expected, `${name} 没有登记哈希`).toMatch(/^[0-9A-F]{64}$/);
      expect(expected, `${name} 的哈希还是占位的全零：运行 node scripts/win-helper-hashes.mjs 写回`).not.toMatch(/^0+$/);
      const actual = assetSha256(fs.readFileSync(path.join(ASSETS, name)));
      expect(actual, `${name} 改过但没更新哈希：运行 node scripts/win-helper-hashes.mjs 写回`).toBe(expected);
    });
  }

  it("登记的文件名恰好是三个资源文件（不多不少）", () => {
    expect(Object.keys(HELPER_ASSET_SHA256).sort()).toEqual(Object.values(ASSET_FILES).sort());
  });

  it("哈希按「LF 换行、去 BOM」的内容算：git 把换行换成 CRLF、编辑器加 BOM 都不影响", () => {
    const lf = Buffer.from("line1\nline2\n", "utf8");
    const crlf = Buffer.from("line1\r\nline2\r\n", "utf8");
    const bom = Buffer.from("\uFEFFline1\r\nline2\r\n", "utf8");
    expect(assetSha256(crlf)).toBe(assetSha256(lf));
    expect(assetSha256(bom)).toBe(assetSha256(lf));
    expect(normalizeAssetBytes(bom).toString("utf8")).toBe("line1\nline2\n");
    expect(assetSha256(lf)).toMatch(/^[0-9A-F]{64}$/);
  });

  it("内容真的变了哈希就变；单独的 CR 不是换行，不被吞", () => {
    expect(assetSha256(Buffer.from("abc"))).not.toBe(assetSha256(Buffer.from("abd")));
    expect(normalizeAssetBytes(Buffer.from("a\rb", "utf8")).toString("utf8")).toBe("a\rb");
  });
});

// ───────────────────────── C# 源码的硬规矩 ─────────────────────────

describe("C# 源码：只用 C# 5 语法（Windows PowerShell 5.1 的 Add-Type 用的是 .NET Framework 的老编译器）", () => {
  const code = stripCSharp(CS);

  it("剥离注释 / 字符串之后还剩下实质代码（解析器没把整份源码吞掉）", () => {
    expect(code.length).toBeGreaterThan(CS.length * 0.4);
    expect(code).toContain("class Typist");
    expect(code).toContain("static int Main");
  });

  // 规则表在 tests/helpers/csharp5-gate.ts（第四轮评审：旧正则漏表达式体属性、内联 out T x、is T x）
  for (const rule of CSHARP5_RULES) {
    it(`没有 ${rule.label}`, () => {
      expect(rule.find(code), `${rule.label} 命中了`).toEqual([]);
    });
  }
});

// 门禁本身也要有证据：规则表不能是「看起来在查、其实什么都没抓」。违规样例全抓得住、合法 C# 5 零误报；
// 两份样例集另外用 Roslyn（C# 5）验证过——违规的每条确实编不过、合法的每条确实能编过（做法见 docs/COMPUTER-USE.md §6 与 csharp5-gate.ts 头注释）
describe("C# 5 语法门禁自身：违规写法都抓得住，合法 C# 5 不误报", () => {
  for (const sample of CSHARP5_VIOLATION_SAMPLES) {
    it(`[${sample.rule}] ${JSON.stringify(sample.code).slice(0, 70)} → 被这条规则抓住`, () => {
      const ids = csharp5Violations(stripCSharp(sample.code)).map((v) => v.id);
      expect(ids).toContain(sample.rule);
    });
  }

  for (const sample of CSHARP5_LEGAL_SAMPLES) {
    it(`合法 C# 5 零误报：${JSON.stringify(sample.code).slice(0, 70)}`, () => {
      expect(csharp5Violations(stripCSharp(sample.code))).toEqual([]);
    });
  }

  it("规则表里每一条都有至少一个违规样例（没被样例证明过的规则不许留在表里）", () => {
    const proven = new Set(CSHARP5_VIOLATION_SAMPLES.map((s) => s.rule));
    for (const rule of CSHARP5_RULES) expect(proven.has(rule.id), `规则 ${rule.id} 没有违规样例`).toBe(true);
    for (const rule of proven) expect(CSHARP5_RULES.some((r) => r.id === rule), `样例引用了不存在的规则 ${rule}`).toBe(true);
  });

  it("规则 id 不重复", () => {
    const ids = CSHARP5_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("C# 源码：密码不进日志、不进命令行 / 环境变量", () => {
  const code = stripCSharp(CS);

  it("每一条 Log.Write 的参数里都不出现和密码有关的标识符（字符串字面量里的中文说明不算）", () => {
    const calls = [...code.matchAll(/Log\.Write\s*\(([^;]*)\)\s*;/g)];
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls) {
      expect(call[1], `Log.Write(${call[1]})`).not.toMatch(/\b(password|passwd|pw|secret|plain\w*|cred\w*)\b/i);
    }
  });

  it("不往环境变量 / Trace / Debug 里写东西", () => {
    expect(code).not.toMatch(/SetEnvironmentVariable/);
    expect(code).not.toMatch(/\bTrace\.\w+/);
    expect(code).not.toMatch(/\bDebug\.Write/);
  });

  it("解密出来的明文用完要清零（Array.Clear）", () => {
    expect(code).toMatch(/Array\.Clear\(password,\s*0,\s*password\.Length\)/);
  });
});

describe("passwordProblem 与 C# Keymap.IsTypeable 同口径", () => {
  it("C# 的长度 / 空判断和 passwordProblem 一致", () => {
    expect(CS).toMatch(/password == null \|\| password\.Length == 0 \|\| password\.Length > Const\.MaxPasswordLength/);
  });
});

// ───────────────────────── UAC 安全桌面：只有读到「会话已锁定」才输入 ─────────────────────────
// 锁屏界面和 UAC 权限确认都在 Winlogon 桌面上，光看桌面名分不开；而往 UAC 里输开机密码再回车，回车默认落在「是」上。
// C# 只能在真 Windows 上跑，这里用静态对账把「怎么判」钉死；真机行为见 docs/windows-unlock-live-test.md 的 UAC 一节。

describe("C# 源码：typist 只有明确读到「会话已锁定」才往里输入（UAC 安全桌面不输）", () => {
  const code = stripCSharp(CS);
  const runBody = code.slice(code.indexOf("internal static int Run(string[] args)"));
  const gateBody = code.slice(code.indexOf("static int CheckLockedForTyping("), code.indexOf("internal static int Run(string[] args)"));

  it("SecureDesktop 退出码是 16：落在「没输过密码」的区间（< 20）；service 回 SECURE_DESKTOP、attempted=0、不进冷却", () => {
    const secure = Number(/internal const int SecureDesktop = (\d+);/.exec(CS)?.[1]);
    expect(secure).toBe(16);
    expect(secure).toBeLessThan(Number(/internal const int StillLocked = (\d+);/.exec(CS)?.[1])); // StillLocked 是「输过」区间的起点
    expect(secure).toBeLessThan(20);
    // service 的映射：紧跟在 case 后面就是 Respond，中间没有 Cooldown.Start()
    expect(CS).toMatch(/case Typist\.SecureDesktop:\s*(?:\/\/[^\n]*\n\s*)*Respond\(pipe, false, "SECURE_DESKTOP", "attempted", "0"\);\s*return;/);
    expect(Object.keys(RESPONSE_CODES)).toContain("SECURE_DESKTOP");
  });

  it("判定函数 CheckLockedForTyping 的顺序：已锁定才放行 → 读不出来按 DesktopError 拒 → Winlogon 且没锁 = SecureDesktop → 唤醒前放行屏保 / 输入前一律拒", () => {
    const order = [
      "state == SessionLock.Locked) return 0;",
      "state == SessionLock.Unknown",
      "return DesktopError;",
      "Desktops.IsWinlogon(inputDesktop)",
      "return SecureDesktop;",
      "if (beforeWake) return 0;",
      "return NotLocked;",
    ].map((snippet) => gateBody.indexOf(snippet));
    for (const [i, idx] of order.entries()) expect(idx, `缺少第 ${i + 1} 段判定`).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("两次检查都在按键之前：第一次在任何输入（唤醒的 Shift / 鼠标）之前，第二次在 Caps Lock 处理和输入密码之前，Enter 最后", () => {
    const at = (snippet: string) => runBody.indexOf(snippet);
    const sequence = [
      "CheckLockedForTyping(runId, input, true)", // 唤醒之前
      "Tap(VK_SHIFT)", // 唤醒：Shift 轻点
      "MoveMouse(1)",
      "CheckLockedForTyping(runId, input, false)", // 输入之前最后一次
      "Tap(VK_CAPITAL)",
      "SendKey(stroke.Vk, false)", // 真正开始输密码
      "StillLockedBeforeSubmit(runId)", // 回车之前最后一次确认（第三轮评审）
      "Tap(VK_RETURN)",
    ];
    const positions = sequence.map(at);
    for (const [i, p] of positions.entries()) expect(p, sequence[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b), `顺序应为：${sequence.join(" → ")}`).toEqual(positions);
    // 两次检查的结果都要用：不为 0 就直接返回它的退出码
    expect(runBody.match(/gate = CheckLockedForTyping\(runId, input, (?:true|false)\);\s*if \(gate != 0\) return gate;/g)).toHaveLength(2);
    // 取密码也在第一次检查之后：锁屏之外的场景连密码都不去解密
    expect(at("CredStore.Load()")).toBeGreaterThan(at("CheckLockedForTyping(runId, input, true)"));
  });

  it("回车之前再确认一次（输密码这几秒里可能被用户自己解开 / 弹出 UAC）：不是锁屏就不按回车，按「输过」收场进冷却；检查紧贴着回车", () => {
    // 第三轮评审：两次检查都在输入密码之前，输密码要几秒——这期间弹出 UAC，回车默认落在「是」上；用户自己解开，回车会落进他的窗口
    const helper = code.slice(code.indexOf("static bool StillLockedBeforeSubmit(string runId)"), code.indexOf("internal static int Run(string[] args)"));
    expect(helper.length).toBeGreaterThan(0);
    const order = ["Desktops.InputName()", "if (input == null)", "return false;", "Desktops.IsDefault(input)", "return false;", "return CheckLockedForTyping(runId, input, false) == 0;"];
    let from = 0;
    for (const snippet of order) {
      const at = helper.indexOf(snippet, from);
      expect(at, `判定顺序：${order.join(" → ")}（缺 ${snippet}）`).toBeGreaterThan(-1);
      from = at + snippet.length;
    }
    // 复用「输入前」那套判定（beforeWake = false：不是锁定的一律拒），而不是另写一套更松的
    expect(helper).not.toContain("CheckLockedForTyping(runId, input, true)");
    // Run 里：密码输完 → Sleep(80)（让最后一个键落稳）→ 检查 → 不通过就 return InputFailedMid（不按回车）→ 通过才 Tap(VK_RETURN)；检查和回车之间没有 Sleep
    expect(runBody).toMatch(/Thread\.Sleep\(80\);\s*if \(!StillLockedBeforeSubmit\(runId\)\) return InputFailedMid;\s*if \(!Tap\(VK_RETURN\)\)/);
    // InputFailedMid 在「输过密码」的区间：service 据此进冷却（宁可多冷却，也不能连着输错）
    expect(Number(/internal const int InputFailedMid = (\d+);/.exec(CS)?.[1])).toBeGreaterThanOrEqual(Number(/internal const int StillLocked = (\d+);/.exec(CS)?.[1]));
    expect(CS).toMatch(/case Typist\.InputFailedMid:\s*Cooldown\.Start\(\);\s*Respond\(pipe, false, "INPUT_FAILED", "attempted", "1"\);/);
  });

  it("SessionLock.Read：只信 Level=1 且结构里的 SessionId 等于本进程会话号的数据；0=已锁、1=没锁、其它=未知；读完必释放；永不抛", () => {
    const body = code.slice(code.indexOf("internal static class SessionLock"), code.indexOf("internal static class Typist"));
    for (const snippet of [
      "Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out mine)",
      "Native.WTSQuerySessionInformation(IntPtr.Zero, CurrentSession, InfoClassSessionInfoEx, out buffer, out bytes)",
      "bytes < MinBytes",
      "level != 1",
      "sessionId != mine",
      "if (flags == 0) return Locked;",
      "if (flags == 1) return Unlocked;",
      "Native.WTSFreeMemory(buffer)",
    ]) {
      expect(body, snippet).toContain(snippet);
    }
    // 校验都在判定「已锁 / 没锁」之前；释放在 finally 里
    expect(body.indexOf("level != 1")).toBeLessThan(body.indexOf("if (flags == 0) return Locked;"));
    expect(body.indexOf("sessionId != mine")).toBeLessThan(body.indexOf("if (flags == 0) return Locked;"));
    expect(body).toMatch(/finally\s*\{\s*if \(buffer != IntPtr\.Zero\) Native\.WTSFreeMemory\(buffer\);\s*\}/);
    expect(body).toMatch(/catch \(Exception ex\)\s*\{[^}]*return Unknown;/);
  });

  it("读系统锁定标志用到的几个 API 声明：wtsapi32 的 W 版本（WTSQuerySessionInformationW）、WTSFreeMemory、kernel32 的 ProcessIdToSessionId", () => {
    expect(CS).toMatch(/\[DllImport\("wtsapi32\.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true\)\]/);
    expect(CS).toContain("internal static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytesReturned);");
    expect(CS).toMatch(/\[DllImport\("wtsapi32\.dll"\)\]\s*internal static extern void WTSFreeMemory\(IntPtr memory\);/);
    expect(CS).toContain("internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);");
  });

  it("C# 的常量和 Node 驱动（win32-defs.mjs）里的一模一样：两边读的是同一个结构、同样的偏移", () => {
    const lit = (name: string): number => {
      const m = new RegExp(`const (?:uint|int) ${name} = (0x[0-9A-Fa-f]+|\\d+);`).exec(CS);
      if (!m) throw new Error(`C# 里找不到 ${name}`);
      return Number(m[1]);
    };
    expect(lit("CurrentSession")).toBe(WTS_CURRENT_SESSION);
    expect(lit("InfoClassSessionInfoEx")).toBe(WTS_SESSION_INFO_EX);
    expect(lit("OffsetLevel")).toBe(WTSINFOEX_OFFSETS.level);
    expect(lit("OffsetSessionId")).toBe(WTSINFOEX_OFFSETS.sessionId);
    expect(lit("OffsetFlags")).toBe(WTSINFOEX_OFFSETS.sessionFlags);
    expect(lit("MinBytes")).toBe(WTSINFOEX_READ_BYTES);
  });

  it("selftest：读不出会话锁定状态就失败（退出码 27）——那样装上了也永远不敢输入；自检结果不限已锁 / 没锁", () => {
    expect(code).toContain("if (lockState == SessionLock.Unknown) return 27;");
    expect(code).not.toMatch(/lockState == SessionLock\.Locked\s*\)\s*return/);
    expect(code).not.toMatch(/lockState == SessionLock\.Unlocked\s*\)\s*return/);
    // 自检失败的退出码 15 的说明里提到这个原因
    expect(describeAdminExit(ADMIN_EXIT.SELFTEST_FAILED)).toMatch(/读不出「当前是否锁屏」/);
  });
});

describe("C# 源码：解锁冷却往安全的一侧倒（状态文件缺失 / 损坏 / 读不了都不能放行）", () => {
  const code = stripCSharp(CS);
  const cooldown = code.slice(code.indexOf("internal static class Cooldown"), code.indexOf("internal static class Native"));

  it("截止时刻同时记在进程内存里：先记内存、再落盘，写盘失败这次运行期间仍然有效", () => {
    expect(cooldown).toContain("memoryUntilTicks = until.Ticks;");
    expect(cooldown.indexOf("memoryUntilTicks = until.Ticks;")).toBeLessThan(cooldown.indexOf("File.WriteAllText(Paths.State"));
  });

  it("Remaining：取内存与文件里更长的那个；文件内容读不懂按「最后修改时间起算一整段」；远在未来的截止时刻夹紧（不是封顶）；文件不存在（FileNotFound / DirectoryNotFound）只回内存里的值", () => {
    expect(cooldown).toContain("Longer(fromMemory, LeftUntil(new DateTime(ticks, DateTimeKind.Utc)))");
    expect(cooldown).toContain("Longer(fromMemory, LeftUntil(File.GetLastWriteTimeUtc(Paths.State).AddSeconds(Const.CooldownSeconds)))");
    // 直接读：只有「文件 / 目录不存在」才回内存里的值；其余异常（没权限 / 被占用）落到外层 catch，按「读不了」处理（有冷却）
    expect(cooldown).toContain("content = File.ReadAllText(Paths.State);");
    expect(cooldown).toMatch(/catch \(FileNotFoundException\)\s*\{\s*ForgetUnreadable\(\);\s*return fromMemory;\s*\}\s*catch \(DirectoryNotFoundException\)\s*\{\s*ForgetUnreadable\(\);\s*return fromMemory;\s*\}/);
    // 第四轮评审：不先问 File.Exists——状态文件在、但所在目录没权限时它也返回 false（吞错），旧写法把「看不见」当成「没有冷却」（少冷却）
    expect(cooldown).not.toContain("File.Exists");
    // 远未来的截止时刻（状态文件被改过 / 时钟被往回拨过）：第一次发现时夹成「那一刻 + 一整段」并固定下来，之后照常倒计时、结束。
    // 不是每次都回满格的封顶——那样读到一个远未来的值，冷却永远结束不了
    expect(cooldown).toContain("if (clampedUntilTicks == 0 || clampedUntilTicks > cap.Ticks) clampedUntilTicks = cap.Ticks;");
    expect(cooldown).toContain("untilUtc = new DateTime(clampedUntilTicks, DateTimeKind.Utc);");
    expect(cooldown).not.toContain("return TimeSpan.FromSeconds(Const.CooldownSeconds);");
    // 夹紧的记忆只由 Start / Clear 重置：旧的、已过期的夹紧值不能把新一轮冷却当场判成「已结束」
    const start = cooldown.slice(cooldown.indexOf("internal static void Start()"), cooldown.indexOf("internal static bool Clear()"));
    const clearFn = cooldown.slice(cooldown.indexOf("internal static bool Clear()"));
    expect(start).toContain("clampedUntilTicks = 0;");
    expect(clearFn).toContain("clampedUntilTicks = 0;");
  });

  it("删凭据不先问 File.Exists（它吞权限错误：删不掉被当成「本来就没有」，调用方回「已清除」、密码其实还在）：只吞「目录不存在」，其余真错误抛出去", () => {
    const code2 = stripCSharp(CS);
    const credDelete = code2.slice(code2.indexOf("internal static void Delete()"), code2.indexOf("internal static class Cooldown"));
    expect(credDelete.length).toBeGreaterThan(50);
    expect(credDelete).not.toContain("File.Exists");
    expect(credDelete).toContain("DeleteIfPresent(Paths.Cred);");
    expect(credDelete).toMatch(/DeleteIfPresent\(Paths\.Cred \+ ""\);/); // 字符串内容被 stripCSharp 清空了：原文是 ".tmp"
    expect(credDelete).toMatch(/static void DeleteIfPresent\(string path\)\s*\{\s*try\s*\{\s*File\.Delete\(path\);\s*\}\s*catch \(DirectoryNotFoundException\)\s*\{\s*\}\s*\}/);
  });

  // 第六轮评审 P2-3：凭据「有没有」曾用 File.Exists（Exists / Load / Save 各一处）——没权限时它也返回 false，把「看不见」当成「没有」：
  // 状态页回「未保存」、解锁回 NO_CREDENTIAL（白白让用户去重新保存），而密码其实还在。
  // 行为证明在 desktop-win-helper-pwsh.test.ts（真实的 CredStore 在 .NET 里跑）；这里钉结构，两边各抓一类回退。
  it("凭据「有没有」整个 CredStore 都不用 File.Exists：Exists 直接取属性（只有文件 / 目录不存在才算没有，其余错误按「可能有」）；Load 经 ReadSealed 直接读；Save 经 WriteSealed 先 Replace、失败再 Move", () => {
    const code3 = stripCSharp(CS);
    const store = code3.slice(code3.indexOf("internal static class CredStore"), code3.indexOf("internal static class Cooldown"));
    expect(store.length).toBeGreaterThan(300);
    expect(store).not.toContain("File.Exists");
    // Exists：取属性成功 = 有；FileNotFound / DirectoryNotFound = 没有；其余一律 true（可能有）——别把「看不见」当成「没有」
    expect(store).toMatch(
      /internal static bool Exists\(\)\s*\{\s*try\s*\{\s*File\.GetAttributes\(Paths\.Cred\);\s*return true;\s*\}\s*catch \(FileNotFoundException\)\s*\{\s*return false;\s*\}\s*catch \(DirectoryNotFoundException\)\s*\{\s*return false;\s*\}\s*catch \(Exception\)\s*\{\s*return true;\s*\}\s*\}/,
    );
    // ReadSealed：只有文件 / 目录不存在才回 null，其余错误（没权限 / 被占用）抛出去，让调用方走「读不出来」那条分支
    expect(store).toMatch(
      /internal static byte\[\] ReadSealed\(\)\s*\{\s*try\s*\{\s*return File\.ReadAllBytes\(Paths\.Cred\);\s*\}\s*catch \(FileNotFoundException\)\s*\{\s*return null;\s*\}\s*catch \(DirectoryNotFoundException\)\s*\{\s*return null;\s*\}\s*\}/,
    );
    expect(store).toContain("byte[] sealedBytes = ReadSealed();");
    // WriteSealed：先 Replace、失败再 Move（Move 在目标还在时一定抛，不会悄悄覆盖，也不会谎报成功）
    expect(store).toMatch(
      /internal static void WriteSealed\(byte\[\] sealedBytes\)\s*\{[\s\S]*?File\.WriteAllBytes\(temp, sealedBytes\);\s*try\s*\{\s*File\.Replace\(temp, Paths\.Cred, null\);\s*\}\s*catch \(Exception\)\s*\{\s*File\.Move\(temp, Paths\.Cred\);\s*\}\s*\}/,
    );
    expect(store).toContain("WriteSealed(ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine));");
  });

  it("文件在、却读不了（被占用 / 没权限）：会倒计时——从最后修改时间起算，连它也拿不到就从「第一次发现读不了」的时刻起算；不再每次都回一整段（那样冷却永不结束）", () => {
    // 第三轮评审：旧写法 catch 里恒回整段 CooldownSeconds，状态文件一直读不了时冷却永远不结束，重新保存密码也清不掉
    expect(cooldown).toMatch(/catch \(Exception ex\)\s*\{[\s\S]*?return Longer\(fromMemory, LeftUntil\(UnreadableBasis\(\)\.AddSeconds\(Const\.CooldownSeconds\)\)\);/);
    expect(cooldown).not.toMatch(/return Longer\(fromMemory, TimeSpan\.FromSeconds\(Const\.CooldownSeconds\)\);/);
    const basis = cooldown.slice(cooldown.indexOf("static DateTime UnreadableBasis()"), cooldown.indexOf("internal static TimeSpan Remaining()"));
    expect(basis).toContain("File.GetLastWriteTimeUtc(Paths.State)");
    expect(basis).toContain("written.Year >= 2000"); // 文件不存在时 .NET 回 1601-01-01，不算有效的修改时间
    expect(basis).toContain("if (unreadableSinceTicks == 0) unreadableSinceTicks = DateTime.UtcNow.Ticks;"); // 只在第一次发现时定下起点，之后固定
    expect(basis).toContain("return new DateTime(unreadableSinceTicks, DateTimeKind.Utc);");
    // 设置页每 3 秒问一次状态：「读不了」的日志只记一次；状态文件又能读 / 被重写 / 被清掉时记忆作废
    expect(cooldown).toMatch(/if \(!unreadableLogged\)\s*\{\s*unreadableLogged = true;/);
    expect(cooldown).toMatch(/static void ForgetUnreadable\(\)\s*\{\s*unreadableSinceTicks = 0;\s*unreadableLogged = false;\s*\}/);
    expect(cooldown.match(/ForgetUnreadable\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(6); // Remaining 的四个出口 + Start + Clear
  });

  it("内容 0 是 Clear 在删不掉状态文件时改写的「已清除」标记：Remaining 把它读成没有冷却（只回内存里的值）", () => {
    expect(cooldown).toMatch(/if \(ticks == 0\)\s*\{\s*ForgetUnreadable\(\);\s*return fromMemory;\s*\}/);
    // 负数 / 超范围的数字不是标记：落到「内容读不懂」那一支，按修改时间起算
    expect(cooldown).toContain("if (ticks > 0 && ticks <= DateTime.MaxValue.Ticks)");
  });

  it("Clear（用户重新保存开机密码）：先清内存；删文件失败就改写成「已清除」标记；两样都失败返回 false、不假装清掉了", () => {
    // 要看日志文案和 "0" 标记，所以取未剥离字符串的原文
    const clear = CS.slice(CS.indexOf("internal static bool Clear()"), CS.indexOf("/// <summary>系统 API 声明</summary>"));
    expect(clear).toContain("internal static bool Clear()");
    expect(clear.indexOf("memoryUntilTicks = 0;")).toBeGreaterThan(-1);
    expect(clear.indexOf("memoryUntilTicks = 0;")).toBeLessThan(clear.indexOf("File.Delete(Paths.State)"));
    // 顺序：删除 → return true；删除失败 → 改写成 "0" → return true；改写也失败 → return false
    // 第四轮评审：删除不先问 File.Exists（没权限时它也返回 false，会把「删不掉」谎报成「已清掉」）；目录都不存在 = 本来就没有状态文件，不算失败
    const order = [
      "File.Delete(Paths.State);",
      "catch (DirectoryNotFoundException)",
      "return true;",
      'Log.Write("warn", "清冷却状态失败（删除）：',
      'File.WriteAllText(Paths.State, "0");',
      "return true;",
      'Log.Write("warn", "清冷却状态失败（改写成已清除标记）：',
      "return false;",
    ];
    let from = 0;
    for (const snippet of order) {
      const at = clear.indexOf(snippet, from);
      expect(at, `缺少或顺序不对：${snippet}`).toBeGreaterThan(-1);
      from = at + snippet.length;
    }
    expect(clear).not.toContain("throw");
  });

  it("DoSet 清不掉冷却记录时：先问「现在还要挡几秒」（Cooldown.StillBlockedSeconds）——大于 0 才如实回 COOLDOWN_NOT_CLEARED（密码已存好 + 还剩几秒）；等于 0（记录已过期）只记 warn、照常回 OK（v3）", () => {
    // 结构钉：行为证明在 desktop-win-helper-pwsh.test.ts（真 Cooldown 类在 .NET 里跑 StillBlockedSeconds）
    const doSet = CS.slice(CS.indexOf("static void DoSet(Stream pipe, Request request)"), CS.indexOf("static void DoClear(Stream pipe)"));
    const save = doSet.indexOf("CredStore.Save(password);");
    const clearCall = doSet.indexOf("if (!Cooldown.Clear())");
    const stillCall = doSet.indexOf("int stillWait = Cooldown.StillBlockedSeconds();");
    const gate = doSet.indexOf("if (stillWait > 0)");
    const notCleared = doSet.indexOf('Respond(pipe, false, "COOLDOWN_NOT_CLEARED", "saved", "1", "wait", stillWait.ToString(CultureInfo.InvariantCulture));');
    const expiredLog = doSet.indexOf('Log.Write("warn", "冷却记录没清掉，但它已经过期，不影响使用");');
    const ok = doSet.indexOf('Respond(pipe, true, "OK");');
    for (const [label, idx] of Object.entries({ save, clearCall, stillCall, gate, notCleared, expiredLog, ok })) expect(idx, label).toBeGreaterThan(-1);
    const order = [save, clearCall, stillCall, gate, notCleared, expiredLog, ok];
    expect(order, "先存密码 → 清冷却 → 清不掉再算还要等几秒 → 大于 0 回 COOLDOWN_NOT_CLEARED → 否则只记日志、最后回 OK").toEqual([...order].sort((a, b) => a - b));
    // 不再在 DoSet 里手写 Remaining()：「清不掉后还要等几秒」只有 StillBlockedSeconds 这一个出口（测试才能真跑它）
    expect(doSet).not.toContain("Cooldown.Remaining()");
    // 大于 0 的分支里：COOLDOWN_NOT_CLEARED 之后紧跟 return，再收口；不是失败后继续往下走去回 OK
    expect(doSet).toMatch(/if \(stillWait > 0\)\s*\{[\s\S]*?"COOLDOWN_NOT_CLEARED"[^\n]*\n\s*return;\s*\}/);
    // 等于 0 的分支（== 走 if 之后的那一小段）只记日志：不 return、不回任何响应；日志不带 ex.Message
    // （下面两项在去掉注释 / 字符串的代码上查：注释里会提到 ex.Message / return）
    const code = stripCSharp(CS);
    const doSetCode = code.slice(code.indexOf("static void DoSet(Stream pipe, Request request)"), code.indexOf("static void DoClear(Stream pipe)"));
    const afterGate = doSetCode.slice(doSetCode.indexOf("return;", doSetCode.indexOf("if (stillWait > 0)")) + "return;".length, doSetCode.lastIndexOf("Respond(pipe, true,"));
    expect(afterGate).toContain("Log.Write(");
    expect(afterGate).not.toMatch(/\breturn\b|Respond\(/);
    expect(doSetCode).not.toContain("ex.Message");
    // StillBlockedSeconds：Cooldown 里的 internal static 小方法，就是 Remaining() 向上取整（0 = 没有冷却在生效）
    const cool = code.slice(code.indexOf("internal static class Cooldown"), code.indexOf("internal static class Native"));
    expect(cool).toMatch(/internal static int StillBlockedSeconds\(\)\s*\{\s*return \(int\)Math\.Ceiling\(Remaining\(\)\.TotalSeconds\);\s*\}/);
    expect(cool).not.toContain("File.Exists");
    // 密码已经没了的 DoClear：清不掉冷却只记日志（密码都删了，冷却输不出任何东西），不影响回 OK
    const doClear = CS.slice(CS.indexOf("static void DoClear(Stream pipe)"), CS.indexOf("static void DoCheck(Stream pipe)"));
    expect(doClear).toMatch(/if \(!Cooldown\.Clear\(\)\) Log\.Write\("warn"/);
    expect(doClear).toContain('Respond(pipe, true, "OK");');
  });

  it("clearCredential（DoClear）有意不设版本闸：函数体里不看 Const.Version / Const.Proto，上方有注释写明原因（装着旧版组件也得能删掉自己的开机密码）", () => {
    const at = CS.indexOf("static void DoClear(Stream pipe)");
    expect(at).toBeGreaterThan(-1);
    // 紧挨着 DoClear 上面一行就是那条注释
    expect(CS.slice(0, at).trimEnd().split("\n").pop()).toContain("有意不设版本闸：用户即使装着旧版组件，也必须能删掉自己保存的开机密码");
    const code2 = stripCSharp(CS);
    const doClearCode = code2.slice(code2.indexOf("static void DoClear(Stream pipe)"), code2.indexOf("static void DoCheck(Stream pipe)"));
    expect(doClearCode.length).toBeGreaterThan(100);
    expect(doClearCode).not.toMatch(/Const\.(Version|Proto)/);
  });
});

describe("C# 源码：管道的访问控制（已知边界要在注释里写明白）", () => {
  it("登记账户的 ACE：读写 + CreateNewInstance + Synchronize；SYSTEM 完全控制；没有给 Everyone / Users / Authenticated Users 的 ACE", () => {
    expect(CS).toContain("PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance | PipeAccessRights.Synchronize");
    expect(CS).toContain("new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl");
    const code = stripCSharp(CS);
    expect(code.match(/AddAccessRule\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/WorldSid|BuiltinUsersSid|AuthenticatedUserSid|AnonymousSid/);
  });

  it("CreateNewInstance 带来的威胁模型（同账户进程可抢先创建同名实例、冒充服务端）写在注释里，与 docs 一致", () => {
    expect(CS).toContain("已知边界（威胁模型）");
    expect(CS).toMatch(/抢先创建同名管道实例/);
    expect(CS).toMatch(/防不了同一账户下的恶意软件/);
    expect(fs.readFileSync(path.join(ROOT, "docs", "COMPUTER-USE.md"), "utf8")).toMatch(/CreateNewInstance/);
  });
});

describe("C# 源码：服务的接受循环——管道实例被占满不能把服务拖死（第二轮评审 #12）", () => {
  // 背景：管道最多 MaxInstances（8）个实例。登记账户下的进程连着不说话（单个连接最长挂 ClientTimeoutMs = 90 秒），
  // 或自己创建同名实例，就能让「创建下一个监听实例」连续失败。旧写法：失败 20 次 `return 7` 退出服务 → 计划任务最多重启 5 次
  // → 之后永久停摆；而且 WaitForConnection 刚接到的客户端会在「建下一个实例」失败时被丢掉。
  // 现在：循环从不因出错退出；先把已连上的客户端交给工作线程、再建下一个实例；坏的监听实例丢掉、按间隔重试、日志限流。
  const code = stripCSharp(CS);
  const run = code.slice(code.indexOf("internal static int Run()"), code.indexOf("static void DisposeQuietly"));
  const loopFrom = run.indexOf("while (true)");
  const loop = run.slice(loopFrom, run.indexOf("finally", loopFrom)).replace(/\s+/g, " ");
  const at = (snippet: string, from = 0) => loop.indexOf(snippet, from);

  it("能取到循环体（下面的检查不是在空串上空转）", () => {
    expect(loopFrom).toBeGreaterThan(-1);
    expect(loop).toContain("listening.WaitForConnection();");
    expect(loop).toContain("catch (Exception ex)");
    expect(loop.length).toBeGreaterThan(400);
  });

  it("循环里没有任何 return：出错不退出服务（退出 = 交给最多重启 5 次的计划任务，之后永久停摆）；也没有「连续失败 N 次」的退出阈值", () => {
    expect(loop).not.toMatch(/\breturn\b/);
    expect(code).not.toMatch(/consecutiveFailures\s*>=?\s*\d+\s*\)\s*\{[^}]*return/);
    expect(CS).not.toContain("连续出错，退出");
    // 起不来（读不到登记账户 / 多次建不出第一个管道 / 写不了 pipe.txt / 已经有实例）仍然是启动阶段的退出：3 4 5 6
    for (const exit of [3, 4, 5, 6]) expect(run, `return ${exit}`).toMatch(new RegExp(`return ${exit};`));
    expect(run).not.toMatch(/return 7;/);
  });

  it("监听实例为空就先建；已连上的这个先交给工作线程（清掉 listening，之后出错的收尾不会把正在服务的连接释放掉），再去建下一个实例", () => {
    const ensure = at("if (listening == null) listening = CreateServer();");
    const wait = at("listening.WaitForConnection();");
    const handoff = at("NamedPipeServerStream connected = listening;");
    const cleared = at("listening = null;", handoff);
    const start = at("worker.Start();");
    const next = at("listening = CreateServer();", start);
    expect(ensure).toBeGreaterThan(-1);
    for (const [name, pos] of Object.entries({ wait, handoff, cleared, start, next })) expect(pos, name).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(wait);
    expect(wait).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(cleared);
    expect(cleared).toBeLessThan(start);
    expect(start).toBeLessThan(next);
    // 连上的那条流只出现在「交给工作线程」这一处（声明 + 委托各一次）：循环里没有别的地方会去碰它
    expect(loop.match(/\bconnected\b/g)).toHaveLength(2);
    expect(loop).toContain("HandleClient(connected)");
  });

  it("出错收尾：丢掉监听实例（可能已经坏了 / 本来就是空的）并置空、按连续次数拉长间隔（前几次 200 毫秒，之后 1 秒），下一圈回到「为空就重建」", () => {
    const catchAt = at("catch (Exception ex)");
    const tail = loop.slice(catchAt);
    expect(tail).toContain("consecutiveFailures++;");
    expect(tail).toContain("DisposeQuietly(listening); listening = null;");
    expect(tail).toContain("Thread.Sleep(consecutiveFailures < 5 ? 200 : 1000);");
    expect(tail.indexOf("consecutiveFailures++;")).toBeLessThan(tail.indexOf("DisposeQuietly(listening);"));
    expect(tail.indexOf("DisposeQuietly(listening); listening = null;")).toBeLessThan(tail.indexOf("Thread.Sleep("));
    // 计数只在「接到并交出一条连接」之后清零；建下一个实例失败时不清零（否则占满期间日志限流和间隔拉长都失效）
    const reset = at("consecutiveFailures = 0;");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(at("worker.Start();"));
    expect(reset).toBeLessThan(at("listening = CreateServer();", at("worker.Start();")));
  });

  it("日志限流：持续同一种故障只记开头 3 次，之后每 60 次一条；日志只有异常类型名，不带异常消息", () => {
    expect(CS).toContain("consecutiveFailures <= 3 || consecutiveFailures % 60 == 0");
    expect(CS).toContain('"接受连接 / 创建管道出错（连续第 " + consecutiveFailures + " 次）：" + ex.GetType().Name');
    const catchLog = CS.slice(CS.indexOf("接受连接 / 创建管道出错"), CS.indexOf("DisposeQuietly(listening);"));
    expect(catchLog).not.toMatch(/ex\.Message|ex\.ToString\(\)|\bex\)/);
  });

  it("DisposeQuietly：对空引用无操作；释放失败也不外抛（catch 吞掉）", () => {
    const fn = code.slice(code.indexOf("static void DisposeQuietly"), code.indexOf("static string ReadLine"));
    expect(fn).toContain("static void DisposeQuietly(IDisposable resource)");
    expect(fn).toMatch(/try\s*\{\s*if \(resource != null\) resource\.Dispose\(\);\s*\}\s*catch\s*\{\s*\}/);
  });
});

describe("安装脚本：安装位置和编译用的临时目录不听环境变量的", () => {
  it("两个脚本都用系统接口取 Program Files / ProgramData，不读 %ProgramFiles% / %ProgramData% / %SystemRoot% / %windir%", () => {
    for (const [name, script] of [["install.ps1", INSTALL_PS1], ["uninstall.ps1", UNINSTALL_PS1]] as const) {
      expect(script, name).toContain("$programFiles = [Environment]::GetFolderPath('ProgramFiles')");
      expect(script, name).toContain("$programData = [Environment]::GetFolderPath('CommonApplicationData')");
      const code = script.replace(/#[^\n]*/g, ""); // 注释里可以提到这些名字
      expect(code, name).not.toMatch(/\$env:(ProgramFiles|ProgramW6432|ProgramData|ALLUSERSPROFILE|SystemRoot|windir|SystemDrive)\b/i);
      expect(code, name).not.toMatch(/GetEnvironmentVariable|ExpandEnvironmentVariables|%[A-Za-z]+%/);
    }
  });

  it("install.ps1：编译前把 TEMP / TMP 指到只有管理员能写的私有目录（先清上次残留），编完不管成败都清掉；Add-Type 在设好 TEMP 之后", () => {
    const code = INSTALL_PS1.replace(/#[^\n]*/g, "");
    const at = (snippet: string) => code.indexOf(snippet);
    for (const snippet of ["$buildDir = Join-Path $dataDir 'build'", "New-ProtectedDir $buildDir $false", "$env:TEMP = $buildDir", "$env:TMP = $buildDir", "Add-Type -TypeDefinition $text"]) {
      expect(at(snippet), snippet).toBeGreaterThan(-1);
    }
    expect(at("Remove-Tree $buildDir")).toBeLessThan(at("New-ProtectedDir $buildDir $false")); // 上次残留先清
    expect(at("New-ProtectedDir $buildDir $false")).toBeLessThan(at("$env:TEMP = $buildDir"));
    expect(at("$env:TEMP = $buildDir")).toBeLessThan(at("Add-Type -TypeDefinition $text"));
    expect(at("$env:TMP = $buildDir")).toBeLessThan(at("Add-Type -TypeDefinition $text"));
    // 编译失败路径和成功路径都清（Add-Type 之后至少两处 Remove-Tree $buildDir）
    const afterCompile = code.slice(at("Add-Type -TypeDefinition $text"));
    expect(afterCompile.match(/Remove-Tree \$buildDir/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 私有目录是「只有 SYSTEM / 管理员」的那种（第二个参数 $false = 不给普通用户读权限）
    expect(code).toMatch(/function New-ProtectedDir\(/);
  });
});
