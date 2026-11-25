/**
 * 群协作文案的「落点」守护：
 * - `prompts/_super.md` **不常驻**群消息的规矩（回复发哪 / 抬头怎么读 / 沉默口径都由每条群消息自带的尾注承担，见
 *   group-non-owner-prompt 的 GROUP_REPLY_* / OWNER_GROUP_NOTE）——没绑群的任务不该为它多付一个字；
 * - 设置页里两处会和实现漂移的文案（会话回收参数、预览跟着开关切换）。
 *
 * 为什么有这个文件：2026-11-19 梳理发现，「群里谁能干什么、回复发哪」的规则散在十几处、各写各的。
 * 一度为了「让所有任务都知道群抬头怎么读」往 `_super.md` 加了一节常驻说明（1.4KB），随后改成「消息自带尾注」撤回——
 * 这里钉住「别再加回去」。字节预算与重复句检测见 tests/group-prompt-budget.test.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf-8");

describe("prompts/_super.md：不常驻群消息的规矩", () => {
  const sup = read("prompts/_super.md");

  it("没有「需求群里的消息」/「群消息怎么读」一类的常驻章节（规矩由每条群消息自带的尾注承担）", () => {
    expect(sup).not.toContain("需求群里的消息");
    expect(sup).not.toContain("群消息怎么读");
    expect(sup).not.toContain("[群消息·来自");
  });

  it("「外部动作」一节仍保留「群里别人的话」原字面（tests/advance-chain-wiring.test.ts 与 advance_next 的工具说明都用这个口径）", () => {
    expect(sup).toContain("群里别人的话");
  });
});

describe("设置页文案 ↔ 实现", () => {
  const block = read("src/components/settings/feishu-bridge-block.tsx");

  it("开关说明讲清休眠会话的两种结局：关 = 真人成员的消息会自动接回会话；开 = 休眠的任务只读答疑；「12~22 分钟」= 空闲回收 TTL ~ TTL + 扫描间隔", () => {
    const runner = read("src/lib/server/task-runner.ts");
    const ttl = Number(/const SESSION_IDLE_TTL_MS = (\d+) \* 60 \* 1000;/.exec(runner)?.[1]);
    const sweep = Number(
      /const SESSION_SWEEP_INTERVAL_MS = (\d+) \* 60 \* 1000;/.exec(runner)?.[1],
    );
    expect(ttl).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(0);
    expect(block).toContain(`${ttl}~${ttl + sweep} 分钟`);
    expect(block).toContain("自动接回来");
    expect(block).toContain("开着时，休眠的任务只能只读答疑");
    // 机器人唤不醒休眠会话（group-route 唤醒段只放行真人），「同权」那行要说清
    expect(block).toContain("机器人唤不醒休眠的会话");
  });

  it("旧说法不再出现：「开关管不到」（休眠时关着开关会自动接回会话了）、「开关开着关着都一样」、「仅有的区别」", () => {
    expect(block).not.toContain("开关管不到");
    expect(block).not.toContain("开关开着关着都一样");
    expect(block).not.toContain("仅有的区别");
  });

  it("「更多规则与提示词」折叠区里的预览跟着开关切换：开 = 约束段、关 = 限制已关声明", () => {
    expect(block).toMatch(
      /feishuGroupNonOwnerGuard\s*\?\s*GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW\s*:\s*GROUP_NON_OWNER_OPEN_NOTE_PREVIEW/,
    );
  });

  it("开关说明指路：想只放开个别事项 → 任务页「上下文文档」里的「所有者备注」", () => {
    expect(block).toContain("上下文文档");
    expect(block).toContain("所有者备注");
  });

  // ── S-1（2026-11-24 评审）：「关 = 同权」不能说成「不限制工具」——同权轮里仍有一批工具由代码恒拒 ──
  // 行内 hint 受字数上限约束，只点名四个最常被问到的 + 「浏览器里的敏感能力」一个类别；完整清单在折叠区（R20-13）
  const HINT_DENIED = ["备注", "定时", "推进", "电脑操作", "浏览器里的敏感能力"];

  it("S-1 行内 hint：写明关着时读写文件 / 命令放开，但备注、定时、推进、电脑操作和浏览器里的敏感能力仍被拒", async () => {
    const { FEISHU_ROW_COPY } = await import("@/components/settings/feishu-bridge-block");
    const hint = FEISHU_ROW_COPY.nonOwnerGuard.hint;
    expect(hint).toContain("可读写文件");
    expect(hint).toContain("仍被拒");
    for (const w of HINT_DENIED) expect(hint, w).toContain(w);
    // 旧的过头说法
    expect(hint).not.toContain("与宿主同权，可以改文件");
    expect(hint).not.toContain("不限制工具");
  });

  /**
   * 工具恒拒表里的每一条 → 折叠区「关」那段里必须出现的词（R20-13）。
   * 键 = GROUP_OPEN_TURN_DENIED_RULES 里那条规则的工具名常量；值 = 文案里点名它的词。
   * 反向把关：下面的用例要求「表里的每个键都在这张对照里」——表里新增一条而这里没登记（= 折叠区文案也多半没写）就红，逼着回来改文案。
   */
  const RULE_COPY_WORDS: Record<string, string> = {
    OWNER_NOTE_TOOL_NAME: "所有者备注",
    SCHEDULE_TOOL_NAME: "新建定时",
    ADVANCE_NEXT_TOOL_NAME: "自动推进",
    CREATE_CUSTOM_ACTION_TOOL_NAME: "自定义 Action",
    BROWSER_STORAGE_TOOL_NAME: "浏览器登录态",
    BROWSER_EVALUATE_TOOL_NAME: "页面脚本",
    BROWSER_NETWORK_TOOL_NAME: "读网络请求 / 响应的正文",
    BROWSER_DEBUG_TOOL_NAME: "带条件断点",
    BROWSER_PERF_TOOL_NAME: "堆快照",
    BROWSER_NET_RULES_TOOL_NAME: "可执行的 mock",
    BROWSER_PERMISSIONS_TOOL_NAME: "授予 / 拒绝 / 重置页面权限",
  };
  /** 恒拒表里每条规则的第一个元素（工具名常量）：形如 `[\n    OWNER_NOTE_TOOL_NAME,\n    {` */
  const ruleKeys = (tools: string): string[] => {
    const map = /const GROUP_OPEN_TURN_DENIED_RULES = new Map[\s\S]*?\n\]\);/.exec(tools)?.[0] ?? "";
    return [...map.matchAll(/^ {2}\[\s*\n {4}([A-Z][A-Z0-9_]*),/gm)].map((m) => m[1]!);
  };

  it("S-1 折叠区「关」那段：同样列全仍被拒的几类，且整份源码里不再出现「不限制工具和改文件」/「不限制工具」", () => {
    for (const w of ["电脑操作", "仍被拒", ...Object.values(RULE_COPY_WORDS)]) {
      expect(block, w).toContain(w);
    }
    expect(block).toContain("不限制读写文件和命令");
    expect(block).not.toContain("不限制工具");
  });

  it("R20-13 反向把关：恒拒表里的每一条规则都在上面的「规则 → 文案词」对照里（且对照里没有表里不存在的键）；对应的词都在折叠区文案里", () => {
    const keys = ruleKeys(read("src/lib/server/flowship-tools.ts"));
    // 解析器自身：恒拒表现有 11 条（少了 = 正则失灵，不是真的少了规则）
    expect(keys.length).toBeGreaterThanOrEqual(11);
    expect([...keys].sort()).toEqual(Object.keys(RULE_COPY_WORDS).sort());
    // 折叠区「关」那一段（到「任务会话已休眠」为止）里逐词出现——不是整份源码里随便哪出现
    const offPara = block.slice(block.indexOf("<b>关</b>：群里的"), block.indexOf("任务会话已休眠"));
    expect(offPara.length).toBeGreaterThan(50);
    for (const key of keys) expect(offPara, key).toContain(RULE_COPY_WORDS[key]!);
  });

  it("R20-13 反向把关的自检：表里多一条没登记的规则 → 解析出的键集合与对照不等（=红）", () => {
    const real = read("src/lib/server/flowship-tools.ts");
    const fake = real.replace(
      /(const GROUP_OPEN_TURN_DENIED_RULES = new Map[^\n]*\n)/,
      "$1  [\n    BROWSER_FAKE_NEW_TOOL_NAME,\n    { reason: \"x\" },\n  ],\n",
    );
    expect(fake).not.toBe(real);
    expect([...ruleKeys(fake)].sort()).not.toEqual(Object.keys(RULE_COPY_WORDS).sort());
    expect(ruleKeys(fake)).toContain("BROWSER_FAKE_NEW_TOOL_NAME");
  });

  it("S-1 文案 ↔ 代码：列出的这几类确实都在 flowship-tools 的同权轮恒拒清单 / desktop_* 专用闸里（改了代码要回来改文案）", () => {
    const tools = read("src/lib/server/flowship-tools.ts");
    const map = /const GROUP_OPEN_TURN_DENIED_RULES = new Map[\s\S]*?\n\]\);/.exec(tools)?.[0] ?? "";
    expect(map.length).toBeGreaterThan(500);
    for (const name of [
      "OWNER_NOTE_TOOL_NAME", // 所有者备注
      "SCHEDULE_TOOL_NAME", // 新建定时
      "ADVANCE_NEXT_TOOL_NAME", // 自动推进
      "CREATE_CUSTOM_ACTION_TOOL_NAME", // 自定义 Action
      "BROWSER_STORAGE_TOOL_NAME", // 浏览器登录态
      "BROWSER_EVALUATE_TOOL_NAME", // 页面脚本
    ]) {
      expect(map, name).toContain(`${name},`);
    }
    // 电脑操作：不在这张表里，咽喉里有专用闸（同权轮也拒 desktop_*）
    expect(tools).toMatch(/isDesktopToolName\(tool\.name\) && desktopDeniedInNonOwnerTurn\(tool\.name, ctx\?\.taskId\)/);
  });

  it("S-1 折叠区里的提示词预览与新文案不矛盾：预览仍是发给 AI 的原文（没改它），UI 另加一句说明它点名的「交卷 / 提 MR」只是口头约束", () => {
    expect(block).toContain("GROUP_NON_OWNER_OPEN_NOTE_PREVIEW");
    expect(block).toContain("「交卷 / 提 MR」只是对 AI 的口头约束");
  });
});

describe("所有者备注的手动入口（确定性授权：不指望 AI 自己调 set_owner_note）", () => {
  it("上下文文档面板的添加表单带说明 + 一键填标题，用的是服务端同一个 OWNER_NOTE_TITLE 常量", () => {
    const panel = read("src/components/tasks/context-docs-panel.tsx");
    expect(panel).toMatch(/import\s*\{[^}]*\bOWNER_NOTE_TITLE\b[^}]*\}\s*from\s*"@\/lib\/owner-note"/);
    expect(panel).toContain("setTitle(OWNER_NOTE_TITLE)");
    expect(panel).toContain("字面范围内的事 AI 会照办");
  });

  it("面板对「所有者备注」的两个坑当场说清楚：超长（与服务端同一个 ownerNoteOverflow）挡住提交并给出原因；提示里点明以 / 或 http 开头也按文本保存", () => {
    const panel = read("src/components/tasks/context-docs-panel.tsx");
    expect(panel).toMatch(/import\s*\{[^}]*\bownerNoteOverflow\b[^}]*\}\s*from\s*"@\/lib\/owner-note"/);
    expect(panel).toMatch(/isOwnerNote\s*=\s*title\.trim\(\)\s*===\s*OWNER_NOTE_TITLE/);
    expect(panel).toMatch(/noteOverflow\s*=\s*isOwnerNote\s*\?\s*ownerNoteOverflow\(docs,\s*content\)\s*:\s*null/);
    // 超限 → canSubmit 为 false（按钮禁用）；原因文字直接展示给用户
    const submit = panel.slice(panel.indexOf("const canSubmit"), panel.indexOf("const resetForm"));
    expect(submit).toMatch(/if\s*\(noteOverflow\)\s*return false/);
    expect(panel).toContain("{noteOverflow ??");
    expect(panel).toContain("内容以 / 或 http 开头也会按文本保存");
  });

  it("手动加的同标题文本文档会被 findOwnerNote 读到（入口与读取同源）；别的标题 / 非文本不算", async () => {
    const { findOwnerNote, OWNER_NOTE_TITLE } = await import("@/lib/owner-note");
    const doc = (over: Record<string, unknown>) =>
      ({ id: "d1", type: "text", title: OWNER_NOTE_TITLE, content: "x", ...over }) as never;
    expect(
      findOwnerNote([doc({ content: "  测试环境的数据随便造  " })]),
    ).toBe("测试环境的数据随便造");
    expect(findOwnerNote([doc({ title: "后端技术方案" })])).toBeUndefined();
    expect(findOwnerNote([doc({ type: "url", content: "https://a.b" })])).toBeUndefined();
  });
});
