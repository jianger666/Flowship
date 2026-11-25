/**
 * desktop_* 的「落盘脱敏 / 折叠行摘要 / Cursor MCP 外壳改写 / 结果状态判定 / 提示词」：
 *  · 打出去的文字（可能是密码）与会打出字符的按键，落盘前必须换成 `[已隐藏 N 字符]`；
 *  · 折叠行是人话，且绝不回显打出去的文字；
 *  · Cursor 路径的 MCP 外壳要和 browser_* 一样被拆成扁平名，失败才不会被落成 success。
 */
import { describe, expect, it } from "vitest";

import {
  CURSOR_CUSTOM_TOOLS_SERVER,
  isCursorBrowserCall,
  toBrowserDisplayCall,
} from "@/lib/cursor-subagent-display";
import { DESKTOP_TOOL_PREFIX, desktopToolSummary, isDesktopToolName } from "@/lib/desktop-tool-display";
import { toolBlockSummary, type ToolBlock } from "@/lib/tool-display";
import { isDesktopBridgeAvailable } from "@/lib/server/browser/bridge";
import {
  desktopKeyTypesCharacter,
  hiddenCharsText,
  redactBrowserArgs,
  redactBrowserToolCallMessage,
} from "@/lib/server/browser/redact-args";
import { __buildChatInitialPromptForTest } from "@/lib/server/chat-runner";
import { DESKTOP_PROMPT_SECTION, desktopPromptSection } from "@/lib/server/desktop/prompt";
import { DESKTOP_TOOL_NAMES } from "@/lib/server/desktop/tools";
import { buildSuperPromptWithBudget } from "@/lib/server/task-prompts";
import { resolveToolResultStatus } from "@/lib/server/tool-result-persist";
import type { Task } from "@/lib/types";

import { CANONICAL_KEYS, KEY_ALIASES } from "../electron-app/desktop/keys.mjs";
import { installFakeBrowser } from "./helpers/browser-bridge-fake";
import { readSource } from "./helpers/source-text";

const block = (name: string, args: string | undefined) =>
  ({ kind: "__tool_block__", id: "b1", callId: "c1", name, status: "completed", text: `调用 ${name}`, args }) as unknown as ToolBlock;

const shell = (toolName: string, inner: Record<string, unknown>, server: string = CURSOR_CUSTOM_TOOLS_SERVER) => ({
  type: "tool_call",
  call_id: "tool_d1",
  name: "mcp",
  status: "running",
  args: { providerIdentifier: server, toolName, args: inner },
});

describe("落盘脱敏：desktop_type / desktop_key", () => {
  it("desktop_type：text 换成占位符（按码点数），submit / screenshot 等结构信息保留", () => {
    expect(redactBrowserArgs("desktop_type", { text: "p@ssw0rd", submit: true })).toEqual({ text: hiddenCharsText(8), submit: true });
    expect(redactBrowserArgs("desktop_type", { text: "你好😀" })).toEqual({ text: hiddenCharsText(3) });
  });

  it("desktop_type：空串不动；已是占位符不再套（幂等）；没有 text 字段返回原引用", () => {
    const empty = { text: "" };
    expect(redactBrowserArgs("desktop_type", empty)).toBe(empty);
    const once = redactBrowserArgs("desktop_type", { text: "abc" });
    expect(redactBrowserArgs("desktop_type", once)).toBe(once);
    const none = { submit: true };
    expect(redactBrowserArgs("desktop_type", none)).toBe(none);
  });

  it("desktop_type：入参是 SDK 流式补全中的 JSON 字符串——能解析就脱敏后重新序列化，半截 JSON 整体隐藏", () => {
    const full = redactBrowserArgs("desktop_type", '{"text":"hunter2","submit":true}') as string;
    expect(JSON.parse(full)).toEqual({ text: hiddenCharsText(7), submit: true });
    const partial = redactBrowserArgs("desktop_type", '{"text":"hunter2-还没写完') as string;
    expect(partial).toBe(hiddenCharsText('{"text":"hunter2-还没写完'.length));
    expect(partial).not.toContain("hunter2");
  });

  it("desktop_key：会打出字符的键（keys / key 两个字段名都盖）隐藏；快捷键 / 功能键保持可读", () => {
    expect(redactBrowserArgs("desktop_key", { keys: "a" })).toEqual({ keys: hiddenCharsText(1) });
    expect(redactBrowserArgs("desktop_key", { key: "7" })).toEqual({ key: hiddenCharsText(1) });
    expect(redactBrowserArgs("desktop_key", { keys: "shift+a", repeat: 2 })).toEqual({ keys: hiddenCharsText(1), repeat: 2 });
    expect(redactBrowserArgs("desktop_key", { keys: "plus" })).toEqual({ keys: hiddenCharsText(1) });
    expect(redactBrowserArgs("desktop_key", { keys: "space" })).toEqual({ keys: hiddenCharsText(1) });
    const combo = { keys: "cmd+shift+v", repeat: 1 };
    expect(redactBrowserArgs("desktop_key", combo)).toBe(combo);
    const named = { keys: "enter" };
    expect(redactBrowserArgs("desktop_key", named)).toBe(named);
    const both = redactBrowserArgs("desktop_key", { keys: "a", key: "b" }) as Record<string, unknown>;
    expect(both).toEqual({ keys: hiddenCharsText(1), key: hiddenCharsText(1) });
  });

  it("desktop_key：主进程认的 space 别名 spacebar 也要隐藏；并与 keys.mjs 的别名表逐条对照（将来加别名漏藏会红）", () => {
    expect(redactBrowserArgs("desktop_key", { keys: "spacebar" })).toEqual({ keys: hiddenCharsText(1) });
    expect(redactBrowserArgs("desktop_key", { keys: "Shift+SpaceBar" })).toEqual({ keys: hiddenCharsText(1) });
    // spacebar 一类别名在审计 / 日志里与 space 同级：打出的是空格这个字符
    const PRINTING = new Set(["space", "plus", "minus"]);
    for (const [alias, canonical] of Object.entries(KEY_ALIASES)) {
      const prints = PRINTING.has(canonical) || canonical.length === 1;
      expect(desktopKeyTypesCharacter(alias), `${alias} → ${canonical}`).toBe(prints);
    }
    // 主进程认的所有「单字符主键」（字母 / 数字 / 标点）本身都要认
    for (const k of CANONICAL_KEYS.filter((x) => x.length === 1)) expect(desktopKeyTypesCharacter(k), k).toBe(true);
    // 命名键（enter / tab / 方向键 / F 键…）不是字符，不能被误藏
    for (const k of CANONICAL_KEYS.filter((x) => x.length > 1 && !PRINTING.has(x))) expect(desktopKeyTypesCharacter(k), k).toBe(false);
  });

  it("desktop_key：流式半截 JSON → 整体隐藏（它在 SECRET_BEARING_TOOLS 里）", () => {
    const out = redactBrowserArgs("desktop_key", '{"keys":"p') as string;
    expect(out).toMatch(/^\[已隐藏 \d+ 字符\]$/);
  });

  it("其它 desktop_* 工具（点击 / 截图 / 打开应用…）不被误伤：原样返回同一引用", () => {
    for (const [name, args] of [
      ["desktop_click", { x: 1, y: 2 }],
      ["desktop_open_app", { name: "微信" }],
      ["desktop_screenshot", {}],
      ["desktop_scroll", { dy: 3 }],
    ] as const) {
      expect(redactBrowserArgs(name, args), name).toBe(args);
    }
    // 半截 JSON：不带明文的工具保持原样
    expect(redactBrowserArgs("desktop_click", '{"x":1,')).toBe('{"x":1,');
  });

  it("不是 desktop_ 前缀的相近名字不沾光：desktop / desktoptype / mydesktop_type", () => {
    for (const name of ["desktop", "desktoptype", "mydesktop_type", "shell"]) {
      const args = { text: "visible" };
      expect(redactBrowserArgs(name, args), name).toBe(args);
    }
  });

  it("大小写不敏感（与 browser_ 同口径）", () => {
    expect(redactBrowserArgs("Desktop_Type", { text: "abc" })).toEqual({ text: hiddenCharsText(3) });
  });

  it("Cursor MCP 外壳：args.args 里的 text 被脱敏；外壳字段不动", () => {
    const wrapped = { providerIdentifier: CURSOR_CUSTOM_TOOLS_SERVER, toolName: "desktop_type", args: { text: "secret!", submit: true } };
    const out = redactBrowserArgs("mcp", wrapped) as typeof wrapped;
    expect(out.providerIdentifier).toBe(CURSOR_CUSTOM_TOOLS_SERVER);
    expect(out.toolName).toBe("desktop_type");
    expect(out.args).toEqual({ text: hiddenCharsText(7), submit: true });
    // 归一化展示名 mcp:<server>:<tool>
    const norm = redactBrowserArgs("mcp:custom-user-tools:desktop_type", { text: "secret!" });
    expect(norm).toEqual({ text: hiddenCharsText(7) });
  });

  it("redactBrowserToolCallMessage：改了返回浅拷贝（不动原消息），没改返回同一引用", () => {
    const msg = { type: "tool_call", name: "desktop_type", args: { text: "pw" } };
    const out = redactBrowserToolCallMessage(msg);
    expect(out).not.toBe(msg);
    expect(out.args).toEqual({ text: hiddenCharsText(2) });
    expect(msg.args).toEqual({ text: "pw" });
    const clean = { type: "tool_call", name: "desktop_click", args: { x: 1, y: 2 } };
    expect(redactBrowserToolCallMessage(clean)).toBe(clean);
  });

  it("desktopKeyTypesCharacter 对照表（与结果回显共用同一判定）", () => {
    const typing = ["a", "Z", "7", "!", "你", "Shift+a", "shift+A", "alt+e", "opt+e", "option+e", "plus", "minus", "space", "shift+plus", "Shift+Space", "shift+opt+x"];
    const shortcuts = ["enter", "escape", "tab", "backspace", "delete", "up", "f5", "cmd+c", "ctrl+shift+t", "alt+f4", "cmd+plus", "ctrl+minus", "mod+a", "cmd+space", "shift+tab", "home"];
    for (const k of typing) expect(desktopKeyTypesCharacter(k), `应判为会打字：${k}`).toBe(true);
    for (const k of shortcuts) expect(desktopKeyTypesCharacter(k), `应判为快捷键：${k}`).toBe(false);
  });
});

describe("折叠行摘要（desktopToolSummary）", () => {
  it("isDesktopToolName：只认 desktop_ 前缀（大小写不敏感）", () => {
    expect(DESKTOP_TOOL_PREFIX).toBe("desktop_");
    expect(isDesktopToolName("desktop_click")).toBe(true);
    expect(isDesktopToolName("Desktop_Type")).toBe(true);
    expect(isDesktopToolName("desktop")).toBe(false);
    expect(isDesktopToolName("browser_click")).toBe(false);
  });

  it("每个工具都有文案；不是 desktop_ 工具返回空串", () => {
    for (const n of DESKTOP_TOOL_NAMES) expect(desktopToolSummary(n, undefined).length, n).toBeGreaterThan(0);
    expect(desktopToolSummary("browser_click", '{"ref":"e1"}')).toBe("");
    expect(desktopToolSummary("shell", "{}")).toBe("");
  });

  it("click / move / drag / scroll", () => {
    expect(desktopToolSummary("desktop_click", '{"x":320.4,"y":240}')).toBe("点击 (320, 240)");
    expect(desktopToolSummary("desktop_click", '{"x":1,"y":2,"count":2}')).toBe("双击 (1, 2)");
    expect(desktopToolSummary("desktop_click", '{"x":1,"y":2,"count":3,"button":"right"}')).toBe("右键三连击 (1, 2)");
    expect(desktopToolSummary("desktop_click", '{"x":"5","y":"6","button":"middle"}')).toBe("中键点击 (5, 6)");
    expect(desktopToolSummary("desktop_click", "{}")).toBe("点击");
    expect(desktopToolSummary("desktop_move", '{"x":10,"y":20}')).toBe("移动鼠标 (10, 20)");
    expect(desktopToolSummary("desktop_drag", '{"from_x":1,"from_y":2,"to_x":30,"to_y":40}')).toBe("拖动 (1, 2) → (30, 40)");
    expect(desktopToolSummary("desktop_drag", '{"x":1,"y":2,"toX":3,"toY":4}')).toBe("拖动 (1, 2) → (3, 4)"); // 主进程写法的回退
    expect(desktopToolSummary("desktop_drag", '{"from_x":1}')).toBe("拖动");
    expect(desktopToolSummary("desktop_scroll", '{"dy":5}')).toBe("滚动 向下 5 格");
    expect(desktopToolSummary("desktop_scroll", '{"dy":-3,"dx":2}')).toBe("滚动 向上 3 格、向右 2 格");
    expect(desktopToolSummary("desktop_scroll", "{}")).toBe("滚动");
    // 小数：和实际执行同一个取整口径（Math.trunc）——dy=0.4 实际一格没动，不能显示成「向下 0 格」；dy=0.6 也不能显示成「向下 1 格」
    expect(desktopToolSummary("desktop_scroll", '{"dy":0.4}')).toBe("滚动");
    expect(desktopToolSummary("desktop_scroll", '{"dy":0.6}')).toBe("滚动");
    expect(desktopToolSummary("desktop_scroll", '{"dy":-0.4,"dx":0.9}')).toBe("滚动");
    expect(desktopToolSummary("desktop_scroll", '{"dy":2.7}')).toBe("滚动 向下 2 格");
    expect(desktopToolSummary("desktop_scroll", '{"dy":-2.7,"dx":0.4}')).toBe("滚动 向上 2 格"); // 横向取整后是 0：不显示
    expect(desktopToolSummary("desktop_scroll", '{"dy":0.4,"dx":-3.9}')).toBe("滚动 向左 3 格");
  });

  it("type：只给字符数，绝不回显文字；占位符还原成 N，不把占位符自身的长度当输入长度", () => {
    expect(desktopToolSummary("desktop_type", '{"text":"hunter2-secret","submit":true}')).toBe("输入 14 个字符 并回车");
    expect(desktopToolSummary("desktop_type", '{"text":"你好"}')).toBe("输入 2 个字符");
    expect(desktopToolSummary("desktop_type", `{"text":"${hiddenCharsText(12)}"}`)).toBe("输入 12 个字符");
    expect(desktopToolSummary("desktop_type", '{"text":"x","submit":"true"}')).toBe("输入 1 个字符 并回车");
    expect(desktopToolSummary("desktop_type", "{}")).toBe("输入文字");
    expect(desktopToolSummary("desktop_type", '{"text":"hunter2"}')).not.toContain("hunter2");
  });

  it("key：快捷键原样、单字符键只说「单个字符」、repeat 带 ×N", () => {
    expect(desktopToolSummary("desktop_key", '{"keys":"cmd+shift+v"}')).toBe("按键 cmd+shift+v");
    expect(desktopToolSummary("desktop_key", '{"key":"enter","repeat":3}')).toBe("按键 enter ×3");
    expect(desktopToolSummary("desktop_key", '{"keys":"enter","repeat":1}')).toBe("按键 enter");
    expect(desktopToolSummary("desktop_key", `{"keys":"${hiddenCharsText(1)}"}`)).toBe("按键（单个字符）");
    expect(desktopToolSummary("desktop_key", "{}")).toBe("按键");
  });

  it("open_app：应用名限长 24；其余固定文案", () => {
    expect(desktopToolSummary("desktop_open_app", '{"name":"微信"}')).toBe("打开应用「微信」");
    expect(desktopToolSummary("desktop_open_app", `{"name":"${"长".repeat(40)}"}`)).toBe(`打开应用「${"长".repeat(23)}…」`);
    expect(desktopToolSummary("desktop_open_app", "{}")).toBe("打开应用");
    expect(desktopToolSummary("desktop_screenshot", "{}")).toBe("电脑截图");
    expect(desktopToolSummary("desktop_status", undefined)).toBe("查看电脑操作状态");
    expect(desktopToolSummary("desktop_apps", undefined)).toBe("查看运行中的应用");
    expect(desktopToolSummary("desktop_end_session", undefined)).toBe("结束电脑操作");
  });

  it("screenshot 带 foreground:true（锁屏后台模式不够用时 AI 要求解锁）：折叠行里看得出来；其它写法 / false 仍是普通截图", () => {
    expect(desktopToolSummary("desktop_screenshot", '{"foreground":true}')).toBe("电脑截图（要求解锁，用真实屏幕）");
    expect(desktopToolSummary("desktop_screenshot", '{"foreground":"true"}')).toBe("电脑截图（要求解锁，用真实屏幕）");
    expect(desktopToolSummary("desktop_screenshot", '{"foreground":false}')).toBe("电脑截图");
    expect(desktopToolSummary("desktop_screenshot", '{"foreground":1}')).toBe("电脑截图");
    expect(desktopToolSummary("desktop_screenshot", "{")).toBe("电脑截图");
  });

  it("入参解析不了（半截 JSON / 数组 / 非对象）不抛，回落到各工具的无参文案", () => {
    expect(desktopToolSummary("desktop_click", '{"x":')).toBe("点击");
    expect(desktopToolSummary("desktop_click", "[1,2]")).toBe("点击");
    expect(desktopToolSummary("desktop_type", '{"text":"abc')).toBe("输入文字");
  });

  it("接入 toolBlockSummary（事件流工具块的折叠行）；非 desktop 工具不受影响", () => {
    expect(toolBlockSummary(block("desktop_click", '{"x":320,"y":240}'))).toBe("点击 (320, 240)");
    expect(toolBlockSummary(block("desktop_type", `{"text":"${hiddenCharsText(5)}","submit":true}`))).toBe("输入 5 个字符 并回车");
    expect(toolBlockSummary(block("browser_click", '{"ref":"e12"}'))).toBe("点击 e12");
    expect(toolBlockSummary(block("shell", '{"command":"ls -la"}'))).toBe("$ ls -la");
  });
});

describe("Cursor MCP 外壳：desktop_* 与 browser_* 同一套拆壳（isCursorBrowserCall / toBrowserDisplayCall）", () => {
  it("认 mcp + custom-user-tools + desktop_ 前缀", () => {
    expect(isCursorBrowserCall(shell("desktop_click", { x: 1, y: 2 }))).toBe(true);
    expect(isCursorBrowserCall(shell("desktop_end_session", {}))).toBe(true);
    expect(isCursorBrowserCall(shell("browser_click", { ref: "e1" }))).toBe(true); // 不退化
  });

  it("第三方 MCP 里恰好也叫 desktop_xxx 的工具不沾光（server 必须是保留的合成名）", () => {
    const third = shell("desktop_type", { text: "x" }, "some-other-server");
    expect(isCursorBrowserCall(third)).toBe(false);
    expect(toBrowserDisplayCall(third)).toBe(third);
  });

  it("不是 desktop_ / browser_ 前缀的不认；已是扁平名（pi 路径）不认", () => {
    expect(isCursorBrowserCall(shell("desktop", {}))).toBe(false);
    expect(isCursorBrowserCall(shell("submit_work", {}))).toBe(false);
    expect(isCursorBrowserCall({ name: "desktop_click", args: { x: 1 } })).toBe(false);
  });

  it("拆壳：name → desktop_xxx，args → 真入参；result 原样（同一引用，可能带截图）；不动原消息", () => {
    const result = { status: "success", value: { content: [{ text: { text: "已点击" } }, { image: { data: "AAAA", mimeType: "image/jpeg" } }], isError: false } };
    const raw = { ...shell("desktop_click", { x: 1, y: 2 }), status: "completed", result };
    const snapshot = JSON.parse(JSON.stringify(raw));
    const out = toBrowserDisplayCall(raw);
    expect(out.name).toBe("desktop_click");
    expect(out.args).toEqual({ x: 1, y: 2 });
    expect((out as { result?: unknown }).result).toBe(result);
    expect(JSON.parse(JSON.stringify(raw))).toEqual(snapshot);
  });

  it("拆壳后的展示名能被折叠行摘要认出", () => {
    const out = toBrowserDisplayCall(shell("desktop_click", { x: 7, y: 8 }));
    expect(desktopToolSummary(out.name as string, JSON.stringify(out.args))).toBe("点击 (7, 8)");
  });
});

describe("工具结果状态（resolveToolResultStatus）认 desktop_ 前缀的扁平名", () => {
  const cursorEnvelope = (text: string, isError: boolean) => ({ status: "success", value: { isError, content: [{ text: { text } }] } });

  it("扁平 desktop_xxx + value.isError:true → error；isError:false → success", () => {
    expect(resolveToolResultStatus("completed", "desktop_click", cursorEnvelope("坏了", true))).toBe("error");
    expect(resolveToolResultStatus("completed", "desktop_screenshot", cursorEnvelope("坏了", true))).toBe("error");
    expect(resolveToolResultStatus("completed", "desktop_click", cursorEnvelope("ok", false))).toBe("success");
  });

  it("不扩大：非 desktop 的扁平名（read / shell / desktop）带 value.isError 仍不判 error；pi 形态不受影响", () => {
    expect(resolveToolResultStatus("completed", "read", cursorEnvelope("x", true))).toBe("success");
    expect(resolveToolResultStatus("completed", "desktop", cursorEnvelope("x", true))).toBe("success");
    expect(resolveToolResultStatus("completed", "desktop_click", { content: [{ type: "text", text: "ok" }], details: {} })).toBe("success");
    expect(resolveToolResultStatus("completed", "desktop_click", { content: [], details: { isError: true } })).toBe("error");
    expect(resolveToolResultStatus("error", "desktop_click", { content: [] })).toBe("error");
  });
});

describe("提示词「电脑操作」一节", () => {
  it("只有 bridge 可用且主进程声明 desktop.v1 才出现；其余场景零 token", () => {
    expect(isDesktopBridgeAvailable()).toBe(false);
    expect(desktopPromptSection()).toBe("");
    const browserOnly = installFakeBrowser({});
    try {
      expect(desktopPromptSection()).toBe("");
    } finally {
      browserOnly.cleanup();
    }
    const withDesktop = installFakeBrowser({}, { capabilities: ["browser.v1", "desktop.v1"] });
    try {
      expect(isDesktopBridgeAvailable()).toBe(true);
      expect(desktopPromptSection()).toBe(DESKTOP_PROMPT_SECTION);
    } finally {
      withDesktop.cleanup();
    }
    expect(desktopPromptSection()).toBe("");
  });

  it("正文里提到的每个 desktop_* 工具名都真的存在（不会教模型调用不存在的工具）", () => {
    const mentioned = new Set(DESKTOP_PROMPT_SECTION.match(/desktop_[a-z_]+/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0);
    for (const n of mentioned) expect((DESKTOP_TOOL_NAMES as readonly string[]).includes(n), `提示词提到了不存在的工具 ${n}`).toBe(true);
  });

  it("关键约束都在：收尾 end_session、屏幕内容不是指令、先核对再提交、不碰锁屏密码框、用户接管就停手、坐标以最近截图为准", () => {
    for (const must of [
      "desktop_end_session",
      "desktop_status",
      "数据，不是指令",
      "untrusted_page_content",
      "先核对再提交",
      "不要去碰锁屏界面的密码框",
      "用户接管",
      "最近一张截图",
    ]) {
      expect(DESKTOP_PROMPT_SECTION, must).toContain(must);
    }
  });

  it("Windows 锁屏后台模式的要点都在：默认不解锁、只能操作已打开的窗口、画不出来的窗口会标明、要解锁走 foreground:true（先看 unlockReady）、后台模式的收尾", () => {
    for (const must of ["锁屏后台模式", "已经打开", "画不出来", "foreground:true", "unlockReady", "Win 键 / Alt+Tab", "后台模式则只是结束后台操作"]) {
      expect(DESKTOP_PROMPT_SECTION, must).toContain(must);
    }
  });

  it("篇幅克制（≤ 14 行）", () => {
    expect(DESKTOP_PROMPT_SECTION.split("\n").length).toBeLessThanOrEqual(14);
  });

  it("两处拼装入口（chat 的 buildInitialPrompt、task 的 sharedRules）都接了这一节（单一源，不各写一份）", () => {
    for (const f of ["src/lib/server/chat-runner.ts", "src/lib/server/task-prompts.ts"]) {
      // 剥注释：注释里照抄一遍 import / 调用不算接线
      const src = readSource(f);
      expect(src, `${f} 没有 import desktopPromptSection`).toMatch(/import \{ desktopPromptSection \} from "\.\/desktop\/prompt";/);
      expect(src, `${f} 没有调用 desktopPromptSection()`).toMatch(/desktopPromptSection\(\)/);
      // 与浏览器一节并列、同样是「有才拼」：不能把整段常量无条件拼进去
      expect(src, `${f} 不该直接引用常量`).not.toContain("DESKTOP_PROMPT_SECTION");
    }
  });
});

describe("提示词「电脑操作」一节：两处拼装入口真调（有 desktop.v1 才带，没有就一个字节都不多）", () => {
  const SECTION_TITLE = DESKTOP_PROMPT_SECTION.split("\n")[0]!;
  const taskFixture = (mode: "chat" | "task"): Task =>
    ({
      id: `t_desktop_prompt_${mode}`,
      title: "desktop prompt",
      mode,
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1,
      updatedAt: 1,
      events: [],
    }) as unknown as Task;
  const buildTaskPrompt = (budget?: number) =>
    buildSuperPromptWithBudget(
      taskFixture("task"),
      [],
      {
        action: { id: "act_1", n: 1, type: "plan", status: "pending", userInstruction: "", artifactPath: "actions/1-plan.md", startedAt: null, endedAt: null } as never,
        userInstruction: "",
      },
      "",
      "",
      "",
      "",
      budget,
    );
  const buildChatPrompt = () =>
    __buildChatInitialPromptForTest(taskFixture("chat"), [], "（用户规则占位）", { text: "x" }, "", "", "", "", false, { turns: [], truncated: false });
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("task 的 super prompt：主进程声明 desktop.v1 → 整段原文恰好出现一次，且在 sharedRules（L1）的字节统计里", async () => {
    const without = await buildTaskPrompt();
    expect(without.prompt).not.toContain(SECTION_TITLE);
    const withDesktop = installFakeBrowser({}, { capabilities: ["browser.v1", "desktop.v1"] });
    try {
      const r = await buildTaskPrompt();
      expect(count(r.prompt, DESKTOP_PROMPT_SECTION)).toBe(1);
      expect(count(r.prompt, SECTION_TITLE)).toBe(1);
      // 字节精确计入 sharedRules：比没有这一段时恰好多出「两个换行 + 整段」
      expect(r.perSectionBytes["sharedRules"] - without.perSectionBytes["sharedRules"]).toBeGreaterThanOrEqual(
        Buffer.byteLength(`\n\n${DESKTOP_PROMPT_SECTION}`, "utf-8"),
      );
      // 预算极小时 L1 不被裁：这一段还在
      const tiny = await buildTaskPrompt(1);
      expect(tiny.dropped.map((d) => d.name)).not.toContain("sharedRules");
      expect(tiny.prompt).toContain(DESKTOP_PROMPT_SECTION);
    } finally {
      withDesktop.cleanup();
    }
  });

  it("task 的 super prompt：只有浏览器能力（没有 desktop.v1）→ 不带这一节，也不改变 sharedRules 字节", async () => {
    const without = await buildTaskPrompt();
    const browserOnly = installFakeBrowser({});
    try {
      const r = await buildTaskPrompt();
      expect(r.prompt).not.toContain(SECTION_TITLE);
      expect(r.prompt).not.toContain("desktop_end_session");
    } finally {
      browserOnly.cleanup();
    }
    // 无壳场景下与基线一致（上面 without 是在没有任何 bridge 时拼的）
    expect((await buildTaskPrompt()).perSectionBytes["sharedRules"]).toBe(without.perSectionBytes["sharedRules"]);
  });

  it("task 的 super prompt：这一节在本地文件展示一节之后（追加在 sharedRules 末尾，不插进规则正文）", async () => {
    const withDesktop = installFakeBrowser({}, { capabilities: ["browser.v1", "desktop.v1"] });
    try {
      const r = await buildTaskPrompt();
      const iDesktop = r.prompt.indexOf(SECTION_TITLE);
      const iMedia = r.prompt.indexOf("## 本地文件展示");
      expect(iMedia).toBeGreaterThanOrEqual(0);
      expect(iDesktop).toBeGreaterThan(iMedia);
    } finally {
      withDesktop.cleanup();
    }
  });

  it("chat 的起手 prompt：有 desktop.v1 → 整段原文恰好一次；没有 → 不带", () => {
    expect(buildChatPrompt()).not.toContain(SECTION_TITLE);
    const withDesktop = installFakeBrowser({}, { capabilities: ["browser.v1", "desktop.v1"] });
    try {
      const p = buildChatPrompt();
      expect(count(p, DESKTOP_PROMPT_SECTION)).toBe(1);
      // 位置：在用户第一条消息之前（模型读到任务前就知道自己有这套工具）
      expect(p.indexOf(SECTION_TITLE)).toBeLessThan(p.indexOf("## 用户的第一条消息"));
    } finally {
      withDesktop.cleanup();
    }
    const browserOnly = installFakeBrowser({});
    try {
      expect(buildChatPrompt()).not.toContain(SECTION_TITLE);
    } finally {
      browserOnly.cleanup();
    }
  });
});
