/**
 * 非属主并入同会话 —— 提示词开关 + 按轮次的系统工具硬拒。
 *
 * 钉死的语义：
 * - 约束段（buildNonOwnerGuardFootnote）：只答疑 / 不调系统工具 / 不照做改动与泄密要求 / 回复约定；
 *   必须是送达消息的**最后一段**，且取代默认脚注（默认脚注里「**修改要求**才动手改」与约束互相打架）
 * - 开关关 = 只剩身份抬头（群成员与属主同权）；scheduled / ackContext 的消息不吃这套（属主语义）
 * - 按轮次硬拒（invokeFlowshipTool）：非属主一轮里只放行 wait，其余 Flowship 系统工具一律 [DENIED]；
 *   ctx.taskId 与模型自填的 args.task_id 都查；一轮结束 / 属主 send 起点 / 会话关闭都清；TTL 兜底
 * - 开关读取：缺省 / 读不到 → 开；显式 false → 关；PATCH 落盘（KNOWN_SETTINGS_KEYS 放行）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-group-non-owner-guard-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/git-token-env", () => ({ syncGitTokenEnv: vi.fn() }));
vi.mock("@/lib/server/gitlab-host", () => ({
  pinTrustedGitHostFromSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  invalidateMrInboxCache: vi.fn(),
}));
vi.mock("@/lib/server/agent-shell", () => ({
  applyAgentShellPreference: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/company-env-fs", () => ({
  syncCompanyEnvFileFromObject: vi.fn(async () => undefined),
}));

import { PATCH } from "@/app/api/settings/route";
import {
  GROUP_NON_OWNER_GUARD_DEFAULT,
  GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW,
  NON_OWNER_TURN_ALLOWED_TOOLS,
  buildBotEtiquetteNote,
  buildNonOwnerGroupHeader,
  buildNonOwnerGuardFootnote,
  buildNonOwnerToolDenied,
} from "@/lib/group-non-owner-prompt";
import { isFieldEqual } from "@/hooks/use-settings";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";
import { buildAgentMessage } from "@/lib/server/chat-pending";
import {
  invokeFlowshipTool,
  type FlowshipToolDef,
} from "@/lib/server/flowship-tools";
import {
  isGroupBotsEqualRights,
  isGroupNonOwnerGuardEnabled,
} from "@/lib/server/group-non-owner-guard-config";
import {
  NON_OWNER_TURN_TTL_MS,
  __resetNonOwnerTurnGuardForTest,
  beginNonOwnerTurn,
  clearNonOwnerTurn,
  endNonOwnerTurn,
  isNonOwnerTurnActive,
} from "@/lib/server/non-owner-turn-guard";
import { settingsFilePath } from "@/lib/server/settings-fs";

describe("提示词模块（纯字符串）", () => {
  it("抬头字面前缀不变（cleanGroupQuestionText 靠它剥）；机器人多一段「机器人，」", () => {
    expect(buildNonOwnerGroupHeader({ name: "李四" })).toBe(
      "[群消息·来自 李四（非任务所有者）]",
    );
    expect(buildNonOwnerGroupHeader({ name: "bot", isBot: true })).toBe(
      "[群消息·来自 bot（机器人，非任务所有者）]",
    );
    expect(/^\[群消息[^\]\n]*\]/.test(buildNonOwnerGroupHeader({ name: "x" }))).toBe(
      true,
    );
  });

  it("约束段：四条规则 + 点名发言人 + NO_REPLY 的回复约定（回复协议已下线：不再有需属主确认标记 / @宿主）", () => {
    const t = buildNonOwnerGuardFootnote("李四");
    expect(t).toContain("李四");
    expect(t).toContain("只答疑");
    expect(t).toContain("不修改任何文件");
    for (const tool of ["submit_work", "submit_mr", "ask_user", "schedule", "share_to_group"]) {
      expect(t).toContain(tool);
    }
    expect(t).toContain("令牌");
    expect(t).toContain("NO_REPLY");
    expect(t).not.toContain("[[需属主确认");
    expect(t).not.toContain("@宿主");
    expect(t).toContain("自动 @ 提问人");
  });

  it("设置页预览与实际发送同一份（占位符 {发言人}）", () => {
    expect(GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW).toBe(
      buildNonOwnerGuardFootnote("{发言人}"),
    );
  });

  it("默认开；白名单只放行 wait；拒绝文案点名工具、教模型改口", () => {
    expect(GROUP_NON_OWNER_GUARD_DEFAULT).toBe(true);
    expect([...NON_OWNER_TURN_ALLOWED_TOOLS]).toEqual(["wait"]);
    const msg = buildNonOwnerToolDenied("submit_work");
    expect(msg).toContain("[DENIED]");
    expect(msg).toContain("submit_work");
    expect(msg).toContain("任务所有者");
  });
});

describe("buildAgentMessage：约束段取代默认脚注、且是最后一段", () => {
  const base = {
    kind: "user_message" as const,
    text: "[群消息·来自 李四（非任务所有者）]\n这个接口返回啥？",
  };

  it("guard 开：以约束段结尾；不含默认脚注的「**修改要求**才动手改」", () => {
    const out = buildAgentMessage({
      ...base,
      groupNonOwnerGuard: { name: "李四" },
    });
    expect(out.endsWith(buildNonOwnerGuardFootnote("李四"))).toBe(true);
    expect(out).toContain("这个接口返回啥？");
    expect(out).not.toContain("**修改要求**才动手改");
  });

  it("guard 关（不传）：没有约束段，保持原默认脚注", () => {
    const out = buildAgentMessage(base);
    expect(out).not.toContain("非任务所有者「");
    expect(out).toContain("**修改要求**才动手改");
  });

  it("scheduled / ackContext 的消息不吃约束段（属主语义）", () => {
    const sched = buildAgentMessage({
      ...base,
      scheduled: true,
      groupNonOwnerGuard: { name: "李四" },
    });
    expect(sched).not.toContain("非任务所有者「");
    const ack = buildAgentMessage({
      ...base,
      ackContext: { actionId: "act-1", artifactPath: "a.md" },
      groupNonOwnerGuard: { name: "李四" },
    });
    expect(ack).not.toContain("非任务所有者「");
    expect(ack).toContain("〈产出审阅中〉");
  });
});

describe("机器人克制提示（同权但仍防互 @ 成环）", () => {
  const base = {
    kind: "user_message" as const,
    text: "[群消息·来自 别家机器人（机器人，非任务所有者）]\n这个接口返回啥？",
  };

  it("buildBotEtiquetteNote：只有克制规则（必须 @ 它 / 没问实质问题 NO_REPLY / 别客套），**没有**「只答疑」限制", () => {
    const t = buildBotEtiquetteNote("别家机器人");
    expect(t).toContain("机器人「别家机器人」");
    expect(t).toContain("必须在正文里 @ 它");
    expect(buildBotEtiquetteNote("别家机器人", "ou_otherbot")).toContain(
      '<at user_id="ou_otherbot">别家机器人</at>',
    );
    expect(t).toContain("NO_REPLY");
    expect(t).toContain("别回「收到」");
    expect(t).not.toContain("不修改任何文件");
    expect(t).not.toContain("不调用 submit_work");
  });

  it("与约束段里机器人变体的第 4 条是同一份规则（不漂移）", () => {
    const rule = buildBotEtiquetteNote("别家机器人").replace(/^（[^。]*。/, "").replace(/）$/, "");
    expect(buildNonOwnerGuardFootnote("别家机器人", { isBot: true })).toContain(`4. ${rule}`);
  });

  it("buildAgentMessage：groupBotEtiquette → 默认脚注 + 克制提示在最后；没带约束段", () => {
    const out = buildAgentMessage({ ...base, groupBotEtiquette: { name: "别家机器人" } });
    expect(out).toContain("**修改要求**才动手改");
    expect(out.endsWith(buildBotEtiquetteNote("别家机器人"))).toBe(true);
    expect(out).not.toContain("本轮规则：");
  });

  it("带了约束段就不重复追加克制提示（约束段里已含同一份规则）", () => {
    const out = buildAgentMessage({
      ...base,
      groupNonOwnerGuard: { name: "别家机器人", isBot: true },
      groupBotEtiquette: { name: "别家机器人" },
    });
    expect(out.endsWith(buildNonOwnerGuardFootnote("别家机器人", { isBot: true }))).toBe(true);
    expect(out.split("两个机器人互相客气会无限循环下去").length - 1).toBe(1);
  });

  it("不传 groupBotEtiquette（真人 / 属主）：不出现克制提示", () => {
    expect(buildAgentMessage(base)).not.toContain("别回「收到」");
  });
});

describe("机器人与真人同权：设置读取（isGroupBotsEqualRights）", () => {
  const BASE = { apiKey: "", defaultModel: { id: "" }, repos: [] };
  const write = (extra: Record<string, unknown> = {}) =>
    fs.writeFile(settingsFilePath(), JSON.stringify({ ...BASE, ...extra }), "utf-8");
  const readDisk = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")) as Record<string, unknown>;

  beforeEach(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
    await fs.mkdir(TMP_ROOT, { recursive: true });
  });

  it("没有设置文件 / 缺省字段 → 关（默认：机器人只答疑）", async () => {
    expect(await isGroupBotsEqualRights()).toBe(false);
    await write();
    expect(await isGroupBotsEqualRights()).toBe(false);
  });

  it("只认显式 true：true → 开；false / 脏值（字符串 \"true\"、1）→ 关", async () => {
    await write({ feishuGroupBotsEqualRights: true });
    expect(await isGroupBotsEqualRights()).toBe(true);
    await write({ feishuGroupBotsEqualRights: false });
    expect(await isGroupBotsEqualRights()).toBe(false);
    await write({ feishuGroupBotsEqualRights: "true" });
    expect(await isGroupBotsEqualRights()).toBe(false);
    await write({ feishuGroupBotsEqualRights: 1 });
    expect(await isGroupBotsEqualRights()).toBe(false);
  });

  it("设置文件损坏 → 关（fail-closed，宁可多约束），不抛", async () => {
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    expect(await isGroupBotsEqualRights()).toBe(false);
  });

  it("读设置**抛错**（readSettingsFile 直接 reject，不是 status 非 ok）→ 关（fail-closed）；提示词开关同口径 → 开（默认）", async () => {
    // 第 21 轮评审 T1：现有用例只钉了 status !== "ok" 分支，没钉 catch 分支（catch 里 return true 即读盘抛错时 fail-open 放机器人同权）；
    // 同第 20 轮 M5b：doMock 换掉 settings-fs，在全新模块实例里验证
    vi.resetModules();
    vi.doMock("@/lib/server/settings-fs", () => ({
      readSettingsFile: async () => {
        throw new Error("EIO: simulated disk failure");
      },
    }));
    try {
      const fresh = await import("@/lib/server/group-non-owner-guard-config");
      expect(await fresh.isGroupBotsEqualRights()).toBe(false);
      expect(await fresh.isGroupNonOwnerGuardEnabled()).toBe(true);
    } finally {
      vi.doUnmock("@/lib/server/settings-fs");
      vi.resetModules();
    }
  });

  it("设置页「有未保存改动」的比较（isFieldEqual）：缺省 ≡ false，与 true 不等（第 21 轮评审 T2：归类写成 boolTrue 会误报）", () => {
    const base = { apiKey: "", defaultModel: { id: "" }, repos: [] } as never;
    const on = { ...(base as object), feishuGroupBotsEqualRights: true } as never;
    const off = { ...(base as object), feishuGroupBotsEqualRights: false } as never;
    expect(isFieldEqual("feishuGroupBotsEqualRights", base, off)).toBe(true);
    expect(isFieldEqual("feishuGroupBotsEqualRights", base, base)).toBe(true);
    expect(isFieldEqual("feishuGroupBotsEqualRights", base, on)).toBe(false);
    expect(isFieldEqual("feishuGroupBotsEqualRights", off, on)).toBe(false);
  });

  it("设置页读到的值（normalizeSettings）：默认 false；只认显式 true；不影响提示词开关的默认", () => {
    expect(DEFAULT_SETTINGS.feishuGroupBotsEqualRights).toBe(false);
    expect(normalizeSettings({}).feishuGroupBotsEqualRights).toBe(false);
    expect(normalizeSettings(null).feishuGroupBotsEqualRights).toBe(false);
    expect(
      normalizeSettings({ feishuGroupBotsEqualRights: true }).feishuGroupBotsEqualRights,
    ).toBe(true);
    expect(
      normalizeSettings({ feishuGroupBotsEqualRights: "true" as unknown as boolean })
        .feishuGroupBotsEqualRights,
    ).toBe(false);
    expect(normalizeSettings({}).feishuGroupNonOwnerGuard).toBe(true);
  });

  it("PATCH 字段级保存放行并落盘（KNOWN_SETTINGS_KEYS 登记过），随后现读即生效", async () => {
    await write();
    const res = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { feishuGroupBotsEqualRights: true } }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await readDisk()).feishuGroupBotsEqualRights).toBe(true);
    expect(await isGroupBotsEqualRights()).toBe(true);
  });
});

describe("按轮次标记（non-owner-turn-guard）", () => {
  beforeEach(() => __resetNonOwnerTurnGuardForTest());
  afterEach(() => __resetNonOwnerTurnGuardForTest());

  it("begin → active；end(token) → 清；缺 taskId 恒为否", () => {
    expect(isNonOwnerTurnActive("t1")).toBe(false);
    const tok = beginNonOwnerTurn("t1");
    expect(isNonOwnerTurnActive("t1")).toBe(true);
    expect(isNonOwnerTurnActive("t2")).toBe(false);
    expect(isNonOwnerTurnActive(undefined)).toBe(false);
    endNonOwnerTurn("t1", tok);
    expect(isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("end 认 token：被后继覆盖后，旧 token 的收口不误清新一轮", () => {
    const old = beginNonOwnerTurn("t1");
    const next = beginNonOwnerTurn("t1");
    endNonOwnerTurn("t1", old);
    expect(isNonOwnerTurnActive("t1")).toBe(true);
    endNonOwnerTurn("t1", next);
    expect(isNonOwnerTurnActive("t1")).toBe(false);
    // 无 token 的 end 是 no-op
    beginNonOwnerTurn("t1");
    endNonOwnerTurn("t1", undefined);
    expect(isNonOwnerTurnActive("t1")).toBe(true);
  });

  it("clear 无条件清（属主 send 起点 / 会话关闭）", () => {
    beginNonOwnerTurn("t1");
    clearNonOwnerTurn("t1");
    expect(isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("TTL 兜底：超时视为不在非属主轮（漏清也最多拒这么久）", () => {
    const now = 1_000_000;
    beginNonOwnerTurn("t1", now);
    expect(isNonOwnerTurnActive("t1", now + NON_OWNER_TURN_TTL_MS - 1)).toBe(true);
    expect(isNonOwnerTurnActive("t1", now + NON_OWNER_TURN_TTL_MS + 1)).toBe(false);
  });
});

describe("invokeFlowshipTool：非属主一轮里只放行 wait", () => {
  beforeEach(() => __resetNonOwnerTurnGuardForTest());
  afterEach(() => __resetNonOwnerTurnGuardForTest());

  const mkTool = (name: string) => {
    const handler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: `ok:${name}` }],
    }));
    const tool = {
      name,
      label: name,
      description: name,
      parameters: {},
      handler,
    } as unknown as FlowshipToolDef;
    return { tool, handler };
  };
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("");

  it.each([
    "submit_work",
    "submit_mr",
    "ask_user",
    "schedule",
    "share_to_group",
    "subagent",
    "some_future_tool",
  ])("非属主一轮：%s 被拒、handler 不执行（白名单放行 → 新增工具默认被拒）", async (name) => {
    beginNonOwnerTurn("t1");
    const { tool, handler } = mkTool(name);
    const r = await invokeFlowshipTool(tool, { task_id: "t1" }, "cb", {
      taskId: "t1",
    });
    expect(textOf(r)).toContain("[DENIED]");
    expect(textOf(r)).toContain(name);
    expect(handler).not.toHaveBeenCalled();
  });

  it("wait 放行（只等待、无副作用）", async () => {
    beginNonOwnerTurn("t1");
    const { tool, handler } = mkTool("wait");
    const r = await invokeFlowshipTool(tool, {}, "cb", { taskId: "t1" });
    expect(textOf(r)).toBe("ok:wait");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("只有模型自填的 args.task_id 命中也拒（不留靠填错 id 绕闸的口子）；ctx 缺省时同理", async () => {
    beginNonOwnerTurn("t1");
    const { tool, handler } = mkTool("submit_work");
    const viaArgs = await invokeFlowshipTool(tool, { task_id: "t1" }, "cb", {
      taskId: "other",
    });
    expect(textOf(viaArgs)).toContain("[DENIED]");
    const noCtx = await invokeFlowshipTool(tool, { task_id: "t1" }, "cb");
    expect(textOf(noCtx)).toContain("[DENIED]");
    expect(handler).not.toHaveBeenCalled();
  });

  it("对照（属主轮 / 一轮已结束 / 别的任务）：照常执行", async () => {
    const { tool, handler } = mkTool("submit_work");
    // 没有标记
    expect(
      textOf(await invokeFlowshipTool(tool, { task_id: "t1" }, "cb", { taskId: "t1" })),
    ).toBe("ok:submit_work");
    // 别的任务的非属主轮不波及 t1
    beginNonOwnerTurn("t2");
    expect(
      textOf(await invokeFlowshipTool(tool, { task_id: "t1" }, "cb", { taskId: "t1" })),
    ).toBe("ok:submit_work");
    // 本任务的轮次结束后恢复
    const tok = beginNonOwnerTurn("t1");
    endNonOwnerTurn("t1", tok);
    expect(
      textOf(await invokeFlowshipTool(tool, { task_id: "t1" }, "cb", { taskId: "t1" })),
    ).toBe("ok:submit_work");
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe("开关读取与落盘", () => {
  const BASE = {
    apiKey: "sk-test-key-0001",
    gitToken: "glpat-xyz",
    defaultModel: { id: "composer-2" },
    repos: [{ name: "web", path: "/repo/web" }],
  };
  const write = (extra: Record<string, unknown> = {}) =>
    fs.writeFile(settingsFilePath(), JSON.stringify({ ...BASE, ...extra }), "utf-8");
  const readDisk = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")) as Record<string, unknown>;

  beforeEach(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
    await fs.mkdir(TMP_ROOT, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  });

  it("没有设置文件 / 缺省字段 → 开（默认）", async () => {
    expect(await isGroupNonOwnerGuardEnabled()).toBe(true);
    await write();
    expect(await isGroupNonOwnerGuardEnabled()).toBe(true);
  });

  it("显式 true → 开；显式 false → 关；脏值（非 boolean false）按开", async () => {
    await write({ feishuGroupNonOwnerGuard: true });
    expect(await isGroupNonOwnerGuardEnabled()).toBe(true);
    await write({ feishuGroupNonOwnerGuard: false });
    expect(await isGroupNonOwnerGuardEnabled()).toBe(false);
    await write({ feishuGroupNonOwnerGuard: "false" });
    expect(await isGroupNonOwnerGuardEnabled()).toBe(true);
  });

  it("设置文件损坏 → 取默认（开），不抛", async () => {
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    expect(await isGroupNonOwnerGuardEnabled()).toBe(true);
  });

  it("PATCH 字段级保存放行并落盘（KNOWN_SETTINGS_KEYS 登记过），随后现读即生效", async () => {
    await write();
    const res = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { feishuGroupNonOwnerGuard: false } }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await readDisk()).feishuGroupNonOwnerGuard).toBe(false);
    expect(await isGroupNonOwnerGuardEnabled()).toBe(false);
  });
});
