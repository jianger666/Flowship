/**
 * 「同权」的群非属主轮里仍由代码恒拒的系统工具：写所有者备注 / 新建定时 / 自动推进 / 挂自定义 Action / 浏览器登录态与页面脚本及其兄弟入口
 * （flowship-tools 的 `groupOpenTurnToolDenied` + 咽喉 `invokeFlowshipTool` + 各 handler 的纵深防御）
 *
 * 背景（评审 #1 #3 b；第二轮评审 #8）：设置里的「限制群里非宿主成员」关着时，群成员与所有者同权，该轮只登记 scope=desktop 的标记（只拦 desktop_*）。
 * 但下面几个工具同权也不该放开，之前全靠提示词口头约束，模型被诱导就破了：
 * - `set_owner_note`：群成员能给自己写「所有者授权」，开关一重开它就成了所有者本人的授权；
 * - `schedule`（create）/ `advance_next`：到点 / 下一步那一轮没有任何「群成员触发」的标记，等于一次无限制的所有者轮，desktop_* 全放行；
 * - `create_custom_action`：挂一个由群成员的话写出来的 skill 当动作按钮，所有者日后点它同样是一次无标记的全权限轮；
 * - `browser_storage` / `browser_evaluate`：读写所有者的 cookie / 登录态、在所有者已登录的页面里跑任意脚本——设置里的开关 / 审批卡是**所有者**的授权，
 *   不是群成员的；
 * - 同一道闸后面的兄弟入口（原则相同：这项能力要所有者的开关 / 审批卡，群成员就不能借 AI 去用）：`browser_network` 读请求 / 响应体、
 *   `browser_debug` 的 scope 与带 condition 的断点、`browser_perf` 的 heap_snapshot、`browser_network_rules` 的 mock、`browser_permissions` 的 grant / deny / reset。
 *   这几个工具的其余动作照常放行。
 * 刻意放行的（同权 = 同事之下的有意取舍）：`submit_mr`（代码类）、`browser_upload`（只能传任务 / 临时 / 下载目录里的文件，shell 本来就能发）。
 *
 * 钉死：
 * - 咽喉：同权轮里这几个按名字（schedule / browser_* 兄弟入口还要看入参）恒拒、handler 一次都不会被调到；拒绝一律带 `isError`（界面不亮绿勾）；
 *   schedule 的 list / cancel、其它系统工具（交卷 / 提问 / 分享 / 预览 / 等待）与浏览器的普通操作照常放行；开关开着（scope=all）与属主轮行为不变；
 * - 真实浏览器工具对账：恒拒表里的名字 / 参数名 / 动作名就是 `getBrowserTools` 真实注册的（漂移就红），被拒时一次 bridge 请求都没发出去；
 * - handler 自己再拒一次：咽喉被绕过 / ctx 没带 taskId 时也拒，且什么都没写；
 * - 名字表：工具名来自模型，`valueOf` / `constructor` / `__proto__` 这类名字不能命中原型上的东西；desktop_* 不在这张表（有专用文案）；
 * - 拒绝文案只陈述「这一次调用被拒」，不做「绝对动不了」的承诺（agent 自带的 shell 不经这道闸），并叮嘱别用命令行绕道。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-group-open-denied-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

const { OWNER_NOTE_TITLE, OWNER_NOTE_TOOL_NAME } = await import("@/lib/owner-note");
const { SCHEDULE_TOOL_NAME } = await import("@/lib/schedule");
const { setOneShotCallerToken } = await import("@/lib/server/chat-pending");
const { flowShipTools, groupOpenTurnToolDenied, invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { getBrowserTools } = await import("@/lib/server/browser/tools");
const { __resetBrowserSettingsForTest } = await import("@/lib/server/browser/settings");
const { DESKTOP_NON_OWNER_DENIED } = await import("@/lib/server/desktop/tools");
const { installFakeBrowser } = await import("./helpers/browser-bridge-fake");
const { ADVANCE_NEXT_TOOL_NAME } = await import("@/lib/server/one-shot-tools");
const { readSchedules } = await import("@/lib/server/schedule-store");
const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { getTask } = await import("@/lib/server/task-fs");
const guard = await import("@/lib/server/non-owner-turn-guard");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`group-open-turn-denied-tools DATA_DIR 未隔离：${taskDir("probe")}`);
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? "").join("");

/** 假工具：只用来看「咽喉有没有放行到 handler」 */
const fakeTool = (name: string) => ({
  name,
  label: name,
  description: "",
  parameters: {} as never,
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] })),
});

const real = (name: string) => flowShipTools.find((t) => t.name === name)!;

/** 内置浏览器里碰所有者登录身份的两个工具（名字写死在测试里：恒拒表改名 / 工具改名而另一边没跟，下面的真实工具对账会红） */
const BROWSER_STORAGE = "browser_storage";
const BROWSER_EVALUATE = "browser_evaluate";
const CUSTOM_ACTION = "create_custom_action";

const TASK = "t_open_denied_gate";
const beginOpen = (taskId = TASK): string => guard.beginNonOwnerTurn(taskId, Date.now(), "desktop");

beforeEach(() => {
  // 过期会话闸（第十八轮）：标记放行的那几个（属主轮 / 别任务的标记）还要求调用方 token 是该任务**当前会话**的——这里的 "tok" 就是 TASK 的当前会话
  setOneShotCallerToken(TASK, "tok");
});

afterEach(() => {
  guard.__resetNonOwnerTurnGuardForTest();
});

describe("咽喉：同权轮（scope=desktop）里这几个恒拒", () => {
  it.each([OWNER_NOTE_TOOL_NAME, ADVANCE_NEXT_TOOL_NAME, CUSTOM_ACTION, BROWSER_STORAGE, BROWSER_EVALUATE])(
    "%s：被拒（带 isError）、handler 没被调到",
    async (name) => {
      beginOpen();
      const tool = fakeTool(name);
      const r = await invokeFlowshipTool(tool, { task_id: TASK }, "tok", { taskId: TASK });
      const t = textOf(r);
      expect(t).toMatch(/^\[DENIED\]/);
      expect(t).toContain(name);
      expect(t).toContain("不要重试");
      expect(r.isError, "拒绝要标 isError，界面才不会把它显示成成功").toBe(true);
      expect(tool.handler).not.toHaveBeenCalled();
    },
  );

  it("三道拒绝（整体白名单 / 电脑操作专用 / 同权恒拒表）都带 isError；放行的调用不带", async () => {
    // ① 开关开着（scope=all）：白名单整体拒
    guard.beginNonOwnerTurn(TASK);
    const all = await invokeFlowshipTool(fakeTool("submit_work"), { task_id: TASK }, "tok", { taskId: TASK });
    expect(textOf(all)).toMatch(/^\[DENIED\]/);
    expect(all.isError).toBe(true);
    guard.__resetNonOwnerTurnGuardForTest();

    // ②③ 同权轮（scope=desktop）
    beginOpen();
    const desktop = await invokeFlowshipTool(fakeTool("desktop_screenshot"), {}, "tok", { taskId: TASK });
    expect(textOf(desktop)).toBe(DESKTOP_NON_OWNER_DENIED);
    expect(desktop.isError).toBe(true);
    const open = await invokeFlowshipTool(fakeTool(OWNER_NOTE_TOOL_NAME), { task_id: TASK }, "tok", { taskId: TASK });
    expect(textOf(open)).toMatch(/^\[DENIED\]/);
    expect(open.isError).toBe(true);

    // 放行的：回包原样，不带 isError
    const ok = await invokeFlowshipTool(fakeTool("ask_user"), { task_id: TASK }, "tok", { taskId: TASK });
    expect(textOf(ok)).toBe("HANDLED:ask_user");
    expect(ok.isError).toBeUndefined();
  });

  it("schedule：只拒 create；list / cancel 没有越权面，照常放行", async () => {
    beginOpen();
    const create = fakeTool(SCHEDULE_TOOL_NAME);
    const denied = await invokeFlowshipTool(
      create,
      { action: "create", title: "t", message: "m", delay_minutes: 10 },
      "tok",
      { taskId: TASK },
    );
    expect(textOf(denied)).toMatch(/^\[DENIED\]/);
    expect(textOf(denied)).toContain("新建定时");
    expect(create.handler).not.toHaveBeenCalled();

    for (const action of ["list", "cancel"]) {
      const tool = fakeTool(SCHEDULE_TOOL_NAME);
      const r = await invokeFlowshipTool(tool, { action, id: "sch_x" }, "tok", { taskId: TASK });
      expect(textOf(r)).toBe(`HANDLED:${SCHEDULE_TOOL_NAME}`);
      expect(tool.handler).toHaveBeenCalledTimes(1);
    }
  });

  it("同权的另一半没变：其它系统工具（交卷 / 提问 / 分享 / 预览 / 等待）与浏览器的普通操作照常放行", async () => {
    beginOpen();
    for (const name of [
      "submit_work",
      "ask_user",
      "share_to_group",
      "preview",
      "wait",
      "expect_group_reply",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_screenshot",
      "browser_read",
      "browser_tabs",
    ]) {
      const tool = fakeTool(name);
      const r = await invokeFlowshipTool(tool, { task_id: TASK }, "tok", { taskId: TASK });
      expect(textOf(r), name).toBe(`HANDLED:${name}`);
    }
  });

  it("没有标记（属主自己的轮）：这几个都照常放行", async () => {
    for (const [name, args] of [
      [OWNER_NOTE_TOOL_NAME, { task_id: TASK, content: "x" }],
      [SCHEDULE_TOOL_NAME, { action: "create", title: "t", message: "m", delay_minutes: 10 }],
      [ADVANCE_NEXT_TOOL_NAME, { task_id: TASK, action: "build" }],
      [BROWSER_STORAGE, { action: "cookies_list" }],
      [BROWSER_EVALUATE, { expression: "1+1" }],
    ] as const) {
      const tool = fakeTool(name);
      const r = await invokeFlowshipTool(tool, { ...args }, "tok", { taskId: TASK });
      expect(textOf(r), name).toBe(`HANDLED:${name}`);
    }
  });

  it("别的任务的标记不连累本任务", async () => {
    beginOpen("t_other_task");
    const tool = fakeTool(OWNER_NOTE_TOOL_NAME);
    const r = await invokeFlowshipTool(tool, { task_id: TASK, content: "x" }, "tok", { taskId: TASK });
    expect(textOf(r)).toBe(`HANDLED:${OWNER_NOTE_TOOL_NAME}`);
  });

  it("开关开着（scope=all）：行为不变——整个系统工具集被拒（走原来的拒绝文案），这几个当然也在内", async () => {
    guard.beginNonOwnerTurn(TASK);
    for (const [name, args] of [
      [OWNER_NOTE_TOOL_NAME, { task_id: TASK, content: "x" }],
      [SCHEDULE_TOOL_NAME, { action: "create" }],
      [ADVANCE_NEXT_TOOL_NAME, { task_id: TASK }],
      [BROWSER_STORAGE, { action: "cookies_list" }],
      [BROWSER_EVALUATE, { expression: "1+1" }],
    ] as const) {
      const tool = fakeTool(name);
      const r = await invokeFlowshipTool(tool, { ...args }, "tok", { taskId: TASK });
      expect(textOf(r), name).toMatch(/^\[DENIED\] 本轮由群里的非任务所有者触发，系统禁止调用 /);
      expect(tool.handler).not.toHaveBeenCalled();
    }
  });
});

describe("handler 自己再拒一次（咽喉被绕过 / ctx 没带 taskId 也拒，且什么都没写）", () => {
  const ids: string[] = [];
  const newTask = async (): Promise<string> => {
    const id = `t_open_denied_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta({
      id,
      title: `open-denied ${id}`,
      mode: "task",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      contextDocs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    setOneShotCallerToken(id, `tok-${id}`);
    return id;
  };
  afterEach(async () => {
    for (const id of ids) await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    ids.length = 0;
  });
  const noteDocs = async (id: string) =>
    ((await getTask(id))?.contextDocs ?? []).filter((d) => d.title === OWNER_NOTE_TITLE);

  it("set_owner_note：直接调 handler（不带 ctx）也拒，备注没写", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = JSON.parse(textOf(await real(OWNER_NOTE_TOOL_NAME).handler({ task_id: id, content: "群成员写的授权" }, `tok-${id}`))) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^\[DENIED\]/);
    expect(await noteDocs(id)).toEqual([]);
  });

  it("set_owner_note：ctx.taskId 指向别的任务、标记登记在 args.task_id（已过 callerToken 校验）上 → 仍拒", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = JSON.parse(
      textOf(await real(OWNER_NOTE_TOOL_NAME).handler({ task_id: id, content: "x" }, `tok-${id}`, { taskId: "t_somewhere_else" })),
    ) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(await noteDocs(id)).toEqual([]);
  });

  it("set_owner_note：没有标记（所有者自己的轮）照常写——这道防御不误伤", async () => {
    const id = await newTask();
    const r = JSON.parse(textOf(await real(OWNER_NOTE_TOOL_NAME).handler({ task_id: id, content: "可以造数" }, `tok-${id}`)));
    expect(r).toEqual({ ok: true, note: "可以造数" });
    expect((await noteDocs(id)).map((d) => d.content)).toEqual(["可以造数"]);
  });

  it("schedule create：直接调 handler 也拒，没有落盘", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = await real(SCHEDULE_TOOL_NAME).handler(
      { action: "create", title: "t", message: "m", delay_minutes: 10 },
      `tok-${id}`,
      { taskId: id },
    );
    expect(textOf(r)).toMatch(/^\[DENIED\]/);
    expect(await readSchedules(id)).toEqual([]);
  });

  it("schedule list：同权轮里照常（只读）", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = await real(SCHEDULE_TOOL_NAME).handler({ action: "list" }, `tok-${id}`, { taskId: id });
    expect(textOf(r)).toBe("本会话没有进行中的定时。");
  });

  it("create_custom_action：直接调 handler 也拒（带 isError），什么都没挂；没有标记（所有者自己的轮）不误伤", async () => {
    const id = await newTask();
    beginOpen(id);
    const denied = await real(CUSTOM_ACTION).handler({ label: "群成员写的按钮", skill: "x-evil-skill" }, `tok-${id}`, { taskId: id });
    expect(textOf(denied)).toMatch(/^\[DENIED\]/);
    expect(textOf(denied)).toContain(CUSTOM_ACTION);
    expect(denied.isError).toBe(true);
    guard.__resetNonOwnerTurnGuardForTest();
    // 所有者自己的轮：走到原来的校验（这里 skill 目录不存在 → 原有的「不在自管目录」文案），不是 [DENIED]
    const owner = await real(CUSTOM_ACTION).handler({ label: "按钮", skill: "x-evil-skill-not-exist" }, `tok-${id}`, { taskId: id });
    expect(textOf(owner)).not.toMatch(/^\[DENIED\]/);
    expect(textOf(owner)).toContain("不在自管目录");
    expect(owner.isError).toBeUndefined();
  });

  it("create_custom_action：ctx 没带 taskId 时不误拒（没有标记可查）", async () => {
    const r = await real(CUSTOM_ACTION).handler({ label: "按钮", skill: "x-evil-skill-not-exist" }, "tok-x");
    expect(textOf(r)).toContain("不在自管目录");
  });

  it("schedule create：纵深防御的拒绝也带 isError", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = await real(SCHEDULE_TOOL_NAME).handler(
      { action: "create", title: "t", message: "m", delay_minutes: 10 },
      `tok-${id}`,
      { taskId: id },
    );
    expect(textOf(r)).toMatch(/^\[DENIED\]/);
    expect(r.isError).toBe(true);
  });

  it("advance_next：直接调 handler（不带 ctx）也拒", async () => {
    const id = await newTask();
    beginOpen(id);
    const r = JSON.parse(
      textOf(await real(ADVANCE_NEXT_TOOL_NAME).handler({ task_id: id, action: "build" }, `tok-${id}`)),
    ) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^\[DENIED\]/);
    expect(r.error).toContain("自动推进");
  });
});

describe("groupOpenTurnToolDenied：名字表", () => {
  it("命中的这几个：文案以 [DENIED] 开头、点名工具和原因、教模型别重试也别绕", () => {
    for (const [name, args] of [
      [OWNER_NOTE_TOOL_NAME, { content: "x" }],
      [SCHEDULE_TOOL_NAME, { action: "create" }],
      [ADVANCE_NEXT_TOOL_NAME, {}],
      [BROWSER_STORAGE, { action: "cookies_list" }],
      [BROWSER_EVALUATE, { expression: "1" }],
    ] as const) {
      const t = groupOpenTurnToolDenied(name, { ...args });
      expect(t, name).toMatch(/^\[DENIED\] 本轮由群里的非任务所有者触发，系统禁止调用 /);
      expect(t, name).toContain(name);
      expect(t, name).toContain("不要重试，也不要想办法绕过");
    }
  });

  it("schedule 只在 action=create 时命中（list / cancel / 缺省 / undefined 入参都不拦）", () => {
    expect(groupOpenTurnToolDenied(SCHEDULE_TOOL_NAME, { action: "create" })).not.toBeNull();
    for (const args of [{ action: "list" }, { action: "cancel" }, {}, undefined]) {
      expect(groupOpenTurnToolDenied(SCHEDULE_TOOL_NAME, args as never)).toBeNull();
    }
  });

  it("工具名来自模型：原型上的名字不能命中（表是 Map，不是对象字面量）", () => {
    for (const name of ["valueOf", "toString", "constructor", "__proto__", "hasOwnProperty", "isPrototypeOf"]) {
      expect(groupOpenTurnToolDenied(name, {}), name).toBeNull();
    }
  });

  it("desktop_* 不在这张表里（它有专用拒绝文案），其它工具也不命中", () => {
    for (const name of ["desktop_screenshot", "desktop_type", "submit_work", "wait", "preview", ""]) {
      expect(groupOpenTurnToolDenied(name, {}), name).toBeNull();
    }
  });

  it("浏览器：只有登录态与页面脚本两个命中，普通操作（导航 / 快照 / 点击 / 输入 / 截图 / 读取 / 标签页）不命中", () => {
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_read",
      "browser_tabs",
      "browser_console",
      "browser_network",
    ]) {
      expect(groupOpenTurnToolDenied(name, {}), name).toBeNull();
    }
    // 名字要精确：前缀 / 大小写 / 多余空白都不命中（命中靠的是工具真实名字，不是模糊匹配）
    for (const name of ["browser_storage_x", "Browser_Storage", " browser_storage", "browser_evaluate "]) {
      expect(groupOpenTurnToolDenied(name, {}), name).toBeNull();
    }
  });
});

describe("groupOpenTurnToolDenied：兄弟入口按入参拒（要所有者开关 / 审批卡的那几个动作），其余放行", () => {
  // [工具, 入参, 该不该拒]。入参来自模型：布尔常写成 "true" / "false" 字符串，动作名可能带空白 / 大小写——拿不准的一律按命中算（宁拒勿放）
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    // browser_network：读请求 / 响应体
    ["browser_network", { request_id: 3, include_body: true }, true],
    ["browser_network", { request_id: 3, include_body: "true" }, true],
    ["browser_network", { request_id: 3, include_body: " TRUE " }, true],
    ["browser_network", { request_id: 3 }, false],
    ["browser_network", { request_id: 3, include_body: false }, false],
    ["browser_network", { request_id: 3, include_body: "false" }, false],
    ["browser_network", {}, false],
    ["browser_network", { action: "list", filter: "failed" }, false],
    ["browser_network", { action: "export_har" }, true], // 默认带 body
    ["browser_network", { action: "export_har", include_bodies: true }, true],
    ["browser_network", { action: "export_har", include_bodies: "yes" }, true], // 写不明白按带 body 算
    ["browser_network", { action: " EXPORT_HAR " }, true],
    ["browser_network", { action: "export_har", include_bodies: false }, false],
    ["browser_network", { action: "export_har", include_bodies: "false" }, false],
    // browser_debug：scope / 带 condition 的断点（与 evaluate 同一道审批）
    ["browser_debug", { action: "scope" }, true],
    ["browser_debug", { action: " Scope " }, true],
    ["browser_debug", { action: "set_breakpoint", url: "app.js", line: 3, condition: "user.token != null" }, true],
    ["browser_debug", { action: "set_breakpoint", url: "app.js", line: 3 }, false],
    ["browser_debug", { action: "set_breakpoint", url: "app.js", line: 3, condition: "" }, false],
    ["browser_debug", { action: "set_breakpoint", url: "app.js", line: 3, condition: "   " }, false],
    ...(["list_breakpoints", "remove_breakpoint", "pause_on_exception", "status", "step_over", "step_into", "step_out", "resume"] as const).map(
      (action): [string, Record<string, unknown>, boolean] => ["browser_debug", { action }, false],
    ),
    // browser_perf：堆快照（同一道审批）
    ["browser_perf", { action: "heap_snapshot" }, true],
    ...(["start_trace", "stop_trace", "metrics", "coverage_start", "coverage_stop"] as const).map(
      (action): [string, Record<string, unknown>, boolean] => ["browser_perf", { action }, false],
    ),
    // browser_network_rules：mock（可执行内容走同一道审批）
    ["browser_network_rules", { action: "mock", pattern: "https://*/api/*" }, true],
    ...(["block", "set_headers", "fail", "delay", "list", "clear"] as const).map(
      (action): [string, Record<string, unknown>, boolean] => ["browser_network_rules", { action }, false],
    ),
    // browser_permissions：授予 / 拒绝 / 重置（「允许 AI 授予页面权限」）；list 只读
    ["browser_permissions", { action: "grant", permission: "geolocation" }, true],
    ["browser_permissions", { action: "deny", permission: "camera" }, true],
    ["browser_permissions", { action: "reset" }, true],
    ["browser_permissions", { action: "list" }, false],
    // create_custom_action：整个工具都拒（入参怎么写都一样）
    [CUSTOM_ACTION, { label: "x", skill: "y" }, true],
    [CUSTOM_ACTION, {}, true],
  ];

  it.each(CASES)("%s %j → %s", (name, args, denied) => {
    const t = groupOpenTurnToolDenied(name, { ...args });
    if (denied) {
      expect(t, `${name} ${JSON.stringify(args)}`).toMatch(/^\[DENIED\] 本轮由群里的非任务所有者触发，系统禁止调用 /);
      expect(t).toContain(name);
      expect(t).toContain("不要重试，也不要想办法绕过");
    } else {
      expect(t, `${name} ${JSON.stringify(args)}`).toBeNull();
    }
  });

  it("入参缺失 / 为 null / 为 undefined 也不抛：有 when 的按「没命中」、整个工具都拒的照拒", () => {
    expect(groupOpenTurnToolDenied("browser_network", undefined)).toBeNull();
    expect(groupOpenTurnToolDenied("browser_network", null as never)).toBeNull();
    expect(groupOpenTurnToolDenied("browser_debug", undefined)).toBeNull();
    expect(groupOpenTurnToolDenied(CUSTOM_ACTION, undefined)).not.toBeNull();
    expect(groupOpenTurnToolDenied(OWNER_NOTE_TOOL_NAME, null as never)).not.toBeNull();
  });

  it("刻意放行的（有意取舍）：submit_mr / browser_upload 不在表里", () => {
    expect(groupOpenTurnToolDenied("submit_mr", { task_id: "t" })).toBeNull();
    expect(groupOpenTurnToolDenied("browser_upload", { ref: "e1", paths: ["/tmp/a.png"] })).toBeNull();
  });
});

describe("同权轮：真实的浏览器工具（假 bridge）——名字对账；被拒时一次主进程请求都没发出去", () => {
  let fake: ReturnType<typeof installFakeBrowser> | null = null;
  beforeEach(() => {
    __resetBrowserSettingsForTest();
    fake = installFakeBrowser({ evaluate: () => ({ type: "number", value: 2 }) });
  });
  afterEach(() => {
    fake?.cleanup();
    fake = null;
  });

  const browserTool = (name: string) => {
    const t = getBrowserTools({ taskId: TASK, readOnly: false }).find((x) => x.name === name);
    if (!t) throw new Error(`假 bridge 在、getBrowserTools 里却没有 ${name}`);
    return t;
  };

  it("前提：恒拒表里的名字就是真实注册的工具名（工具改名而表没跟，这条就红；否则下面的拒绝是对着空气测的）", () => {
    const names = getBrowserTools({ taskId: TASK, readOnly: false }).map((t) => t.name);
    for (const n of [BROWSER_STORAGE, BROWSER_EVALUATE]) {
      expect(names, n).toContain(n);
      expect(groupOpenTurnToolDenied(n, {}), n).not.toBeNull();
    }
  });

  it.each([
    [BROWSER_STORAGE, { action: "cookies_list" }],
    [BROWSER_STORAGE, { action: "export_state", file: "/tmp/state.json" }],
    [BROWSER_EVALUATE, { expression: "document.cookie" }],
  ] as const)("同权轮：真实的 %s（%j）被拒，主进程一次请求都没收到", async (name, args) => {
    beginOpen();
    const r = await invokeFlowshipTool(browserTool(name), { ...args }, "tok", { taskId: TASK });
    expect(textOf(r)).toMatch(/^\[DENIED\]/);
    expect(textOf(r)).toContain(name);
    expect(fake!.calls).toEqual([]);
  });

  it("前提（兄弟入口）：恒拒表按入参判的那些参数名 / 动作名，真实工具的 schema 里都有（改名了而表没跟，这条就红）", () => {
    const tools = getBrowserTools({ taskId: TASK, readOnly: false });
    const schemaOf = (name: string): string => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`getBrowserTools 里没有 ${name}（高级调试组默认注册）`);
      return JSON.stringify(t.parameters);
    };
    const need: Array<[string, string[]]> = [
      ["browser_network", ["include_body", "include_bodies", "export_har", "action"]],
      ["browser_debug", ["action", "scope", "set_breakpoint", "condition"]],
      ["browser_perf", ["action", "heap_snapshot"]],
      ["browser_network_rules", ["action", "mock"]],
      ["browser_permissions", ["action", "grant", "deny", "reset"]],
    ];
    for (const [name, words] of need) {
      const s = schemaOf(name);
      for (const w of words) expect(s, `${name} 的 schema 里应有 ${w}`).toContain(`"${w}"`);
    }
  });

  it.each([
    ["browser_network", { request_id: 1, include_body: true }],
    ["browser_network", { action: "export_har" }],
    ["browser_debug", { action: "scope" }],
    ["browser_debug", { action: "set_breakpoint", url: "app.js", line: 2, condition: "document.cookie" }],
    ["browser_perf", { action: "heap_snapshot" }],
    ["browser_network_rules", { action: "mock", pattern: "https://example.com/*", status: 200, body: "alert(1)" }],
    ["browser_permissions", { action: "grant", permission: "geolocation" }],
    ["browser_permissions", { action: "reset" }],
  ] as const)("同权轮：真实的 %s（%j）被拒，主进程一次请求都没收到", async (name, args) => {
    beginOpen();
    const r = await invokeFlowshipTool(browserTool(name), { ...args }, "tok", { taskId: TASK });
    expect(textOf(r)).toMatch(/^\[DENIED\]/);
    expect(textOf(r)).toContain(name);
    expect(r.isError).toBe(true);
    expect(fake!.calls).toEqual([]);
  });

  it.each([
    ["browser_network", {}],
    ["browser_network", { request_id: 1 }],
    ["browser_network", { action: "export_har", include_bodies: false }],
    ["browser_perf", { action: "metrics" }],
    ["browser_debug", { action: "list_breakpoints" }],
    ["browser_network_rules", { action: "list" }],
    ["browser_permissions", { action: "list" }],
  ] as const)("同权轮：这些兄弟工具的其余动作照常——真实的 %s（%j）走到了主进程", async (name, args) => {
    beginOpen();
    const r = await invokeFlowshipTool(browserTool(name), { ...args }, "tok", { taskId: TASK });
    expect(textOf(r)).not.toMatch(/^\[DENIED\]/);
    expect(fake!.calls.length, `${name} ${JSON.stringify(args)} 没发出请求`).toBeGreaterThan(0);
  });

  it("没有标记（属主自己的轮）：兄弟入口里被拒的那些动作也照常走到主进程", async () => {
    const r = await invokeFlowshipTool(browserTool("browser_network"), { request_id: 1, include_body: true }, "tok", { taskId: TASK });
    expect(textOf(r)).not.toMatch(/^\[DENIED\]/);
    expect(fake!.calls.map((c) => c.op)).toContain("network_detail");
  });

  it("没有标记（属主自己的轮）：真实的 browser_evaluate 照常走到主进程——闸只在群非属主轮才拦", async () => {
    const r = await invokeFlowshipTool(browserTool(BROWSER_EVALUATE), { expression: "1+1" }, "tok", { taskId: TASK });
    expect(textOf(r)).not.toMatch(/^\[DENIED\]/);
    // 工具执行完还会附带发一次 status（页面行），所以只断言 evaluate 确实到了主进程
    expect(fake!.calls.map((c) => c.op)).toContain("evaluate");
  });
});

describe("拒绝文案：只陈述「这一次调用被拒」，不承诺「绝对动不了」", () => {
  // 这些闸只管 Flowship 自己的工具这一个入口；agent 自带的 shell 不经这里——话术里不能写成绝对保证（评审 b）
  const ABSOLUTE = [/不能让 AI 查看或操作/, /更不能让它解锁/, /绝对/, /永远/, /一律不会/, /保证/];
  const samples: Array<[string, string]> = [
    ["desktop_*", DESKTOP_NON_OWNER_DENIED],
    ...(
      [
        [OWNER_NOTE_TOOL_NAME, {}],
        [SCHEDULE_TOOL_NAME, { action: "create" }],
        [ADVANCE_NEXT_TOOL_NAME, {}],
        [CUSTOM_ACTION, {}],
        [BROWSER_STORAGE, {}],
        [BROWSER_EVALUATE, {}],
        ["browser_network", { include_body: true }],
        ["browser_debug", { action: "scope" }],
        ["browser_perf", { action: "heap_snapshot" }],
        ["browser_network_rules", { action: "mock" }],
        ["browser_permissions", { action: "grant" }],
      ] as const
    ).map(([n, a]): [string, string] => [n, groupOpenTurnToolDenied(n, { ...a }) ?? ""]),
  ];

  it.each(samples)("%s：以 [DENIED] 开头、教模型改口（文字回答 / 找任务所有者本人），没有绝对承诺", (_name, t) => {
    expect(t).toMatch(/^\[DENIED\] 本轮由群里的非任务所有者触发，系统(已拒绝|禁止)调用/);
    expect(t).toContain("任务所有者本人");
    for (const re of ABSOLUTE) expect(t, String(re)).not.toMatch(re);
  });

  it("电脑操作：叮嘱别改用命令行（screencapture / osascript / 模拟按键）去做同样的事——这是软约束，文案里不假装它是硬闸", () => {
    expect(DESKTOP_NON_OWNER_DENIED).toContain("不要改用命令行");
    expect(DESKTOP_NON_OWNER_DENIED).toContain("screencapture");
    expect(DESKTOP_NON_OWNER_DENIED).toContain("osascript");
    expect(DESKTOP_NON_OWNER_DENIED).toContain("不要重试");
  });
});
