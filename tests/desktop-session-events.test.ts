/**
 * 电脑操作的会话事件（主进程 evt desktop_session → 任务事件流 + 飞书私聊）：src/lib/server/desktop/session-events.ts。
 * 文案翻译是纯函数；处理器用注入的假依赖；注册走真 bridge + 假传输层。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_SESSION_EVENT,
  describeDesktopSessionEvent,
  ensureDesktopSessionEventsRegistered,
  handleDesktopSessionEvent,
  type DesktopSessionEventDeps,
} from "@/lib/server/desktop/session-events";
import {
  __resetDesktopOpenSessionsForTest,
  hasOpenDesktopSession,
  markDesktopSessionOpen,
} from "@/lib/server/desktop/open-sessions";

import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

interface Recorder {
  deps: DesktopSessionEventDeps;
  titles: string[];
  events: Array<{ taskId: string; text: string; meta: Record<string, unknown> }>;
  feishu: string[];
  warns: string[];
}

/** 假依赖：任务标题表由 titles 决定；其余只记录调用 */
const recorder = (
  tasks: Record<string, string> = { t1: "整理发票" },
  over: Partial<DesktopSessionEventDeps> = {},
): Recorder => {
  const rec: Recorder = { deps: undefined as never, titles: [], events: [], feishu: [], warns: [] };
  rec.deps = {
    taskTitle: async (id) => {
      rec.titles.push(id);
      return id in tasks ? tasks[id]! : null;
    },
    writeTaskEvent: async (taskId, text, meta) => {
      rec.events.push({ taskId, text, meta });
    },
    notifyOwner: async (text) => {
      rec.feishu.push(text);
    },
    warn: (m) => rec.warns.push(m),
    ...over,
  };
  return rec;
};

describe("describeDesktopSessionEvent（纯函数）", () => {
  it("unlocked：写任务流 + 推飞书（带 {task} 占位）", () => {
    const n = describeDesktopSessionEvent({ kind: "unlocked" })!;
    expect(n.text).toContain("已按你的设置自动解锁");
    expect(n.feishu).toContain("{task}");
    expect(n.feishu).toContain("已按你的设置自动解锁");
  });

  it("relocked：写任务流 + 推飞书", () => {
    const n = describeDesktopSessionEvent({ kind: "relocked" })!;
    expect(n.text).toContain("已自动锁回去");
    expect(n.feishu).toContain("已自动锁回去{task}");
  });

  it("relock_failed：醒目告警，带错误原因（单行化），飞书里催用户手动锁屏", () => {
    const n = describeDesktopSessionEvent({ kind: "relock_failed", error: "锁屏命令\n失败 (exit 1)" })!;
    expect(n.text).toContain("没能自动锁回去（锁屏命令 失败 (exit 1)）");
    expect(n.text).toContain("请尽快手动锁屏");
    expect(n.feishu).toContain("：锁屏命令 失败 (exit 1)");
    expect(n.feishu).toContain("请尽快手动锁屏");
    // 没有 error 字段时不留空括号
    expect(describeDesktopSessionEvent({ kind: "relock_failed" })!.text).not.toContain("（）");
  });

  it("unlock_failed：说明已停手 + 10 分钟冷却 + 去检查保存的密码；推飞书", () => {
    const n = describeDesktopSessionEvent({ kind: "unlock_failed", error: "验证未通过" })!;
    expect(n.text).toContain("自动解锁没有成功（验证未通过）");
    expect(n.text).toContain("10 分钟内不会再试");
    expect(n.feishu).toContain("没能自动解锁电脑{task}：验证未通过");
    // 主进程明说进了冷却：同上
    expect(describeDesktopSessionEvent({ kind: "unlock_failed", error: "x", cooldown: true })!.text).toContain("10 分钟内不会再试");
  });

  it("unlock_failed 且 cooldown:false（密码根本没输过：没权限 / 读不到密码 / 密码里有输入不了的字符）：不说「10 分钟」，别让用户白等", () => {
    const n = describeDesktopSessionEvent({ kind: "unlock_failed", error: "没有「辅助功能」权限", cooldown: false })!;
    expect(n.text).toContain("自动解锁没有成功（没有「辅助功能」权限）");
    expect(n.text).toContain("没有输入过开机密码");
    expect(n.text).not.toContain("10 分钟");
    expect(n.feishu).toContain("没能自动解锁电脑{task}：没有「辅助功能」权限");
    expect(n.feishu).not.toContain("10 分钟");
    // 只认严格的 false：缺省 / 字符串 / 0 都按「进了冷却」处理（宁可多说一句等）
    for (const cooldown of [undefined, null, 0, "false", ""]) {
      expect(describeDesktopSessionEvent({ kind: "unlock_failed", error: "x", cooldown })!.text, String(cooldown)).toContain("10 分钟内不会再试");
    }
  });

  it("user_took_over：电脑本来就没锁屏（不是我们解锁的）→ 只写任务流，不推飞书（用户就在电脑前）", () => {
    const n = describeDesktopSessionEvent({ kind: "user_took_over" })!;
    expect(n.text).toContain("检测到你在操作键盘");
    expect(n.feishu).toBeNull();
    // 只有严格的 true 才算「我们解锁的」
    for (const unlockedByUs of [false, undefined, null, 1, "true", "yes"]) {
      expect(describeDesktopSessionEvent({ kind: "user_took_over", unlockedByUs })!.feishu, String(unlockedByUs)).toBeNull();
    }
  });

  it("user_took_over 且电脑是我们解锁的：接管之后不会再锁回去，必须推飞书提醒（用户可能不在电脑前：猫 / 路人 / 鼠标抖动）", () => {
    const n = describeDesktopSessionEvent({ kind: "user_took_over", unlockedByUs: true })!;
    expect(n.text).toContain("原本是锁屏的");
    expect(n.text).toContain("没有重新锁上");
    expect(n.text).toContain("请尽快手动锁屏");
    expect(n.feishu).toContain("{task}");
    expect(n.feishu).toContain("没有重新锁上");
    expect(n.feishu).toContain("请尽快手动锁屏");
  });

  it("relocked 且 reason=overlay_failed（解锁后没盖上遮罩，为安全中止）：说清是怎么回事，而不是一句泛泛的「已锁回去」", () => {
    const n = describeDesktopSessionEvent({ kind: "relocked", reason: "overlay_failed" })!;
    expect(n.text).toContain("没能盖上屏幕遮罩");
    expect(n.text).toContain("没有操作电脑");
    expect(n.feishu).toContain("没能盖上屏幕遮罩");
    expect(n.feishu).toContain("{task}");
    // 其它 reason（正常结束 / 取消）仍是普通的「已锁回去」
    for (const reason of ["task_done", "cancelled", "explicit", undefined]) {
      const g = describeDesktopSessionEvent({ kind: "relocked", reason })!;
      expect(g.text, String(reason)).toBe("🔒 电脑已自动锁回去。");
    }
  });

  it("session_ended：只有异常结束（idle / max_duration / disabled）才说一声，且不推飞书；正常结束沉默", () => {
    expect(describeDesktopSessionEvent({ kind: "session_ended", reason: "idle" })).toMatchObject({ feishu: null, text: expect.stringContaining("长时间没有新动作") });
    expect(describeDesktopSessionEvent({ kind: "session_ended", reason: "max_duration" })).toMatchObject({ feishu: null, text: expect.stringContaining("15 分钟") });
    expect(describeDesktopSessionEvent({ kind: "session_ended", reason: "disabled" })).toMatchObject({ feishu: null, text: expect.stringContaining("关闭了「电脑操作」") });
    for (const reason of ["explicit", "cancelled", "task_done", "server_gone", undefined, 42]) {
      expect(describeDesktopSessionEvent({ kind: "session_ended", reason }), String(reason)).toBeNull();
    }
  });

  it("background_started（Windows 锁屏后台档开始）：只写任务流、不推飞书——电脑一直锁着，没有解锁也没有遮罩，说清楚在做什么即可", () => {
    const n = describeDesktopSessionEvent({ kind: "background_started" })!;
    expect(n.text).toContain("锁屏后台模式");
    expect(n.text).toContain("仍是锁屏状态");
    expect(n.text).toContain("不解锁");
    expect(n.feishu).toBeNull();
  });

  it("foreground_started（后台档升级成前台档）：不展示——紧挨着它之前的 unlocked 事件已经说过「自动解锁」（含飞书），不重复", () => {
    expect(describeDesktopSessionEvent({ kind: "foreground_started" })).toBeNull();
    // 升级过程里用户真正会看到的是 unlocked
    expect(describeDesktopSessionEvent({ kind: "unlocked" })!.feishu).toContain("已按你的设置自动解锁");
  });

  it("session_ended 且 reason=unlocked_externally（锁屏后台操作时用户回来解了锁）：只写任务流", () => {
    const n = describeDesktopSessionEvent({ kind: "session_ended", reason: "unlocked_externally", mode: "background" })!;
    expect(n.text).toContain("你解锁了电脑");
    expect(n.text).toContain("锁屏后台操作已结束");
    expect(n.feishu).toBeNull();
  });

  it("session_ended 且 reason=overlay_incomplete（操作中显示器配置变了、有一块屏幕的遮罩没建出来）：写任务流、不推飞书；锁回去了才说锁回去了", () => {
    const locked = describeDesktopSessionEvent({
      kind: "session_ended",
      reason: "overlay_incomplete",
      unlockedByUs: true,
      relocked: true,
      mode: "foreground",
    })!;
    expect(locked.text).toContain("有一块屏幕没能盖上遮罩");
    expect(locked.text).toContain("并把电脑锁回去了");
    expect(locked.feishu).toBeNull();

    // 没锁成：不能说「锁回去了」（relock_failed 事件另有一条「没能自动锁回去」的提醒，那条才推飞书）
    const notLocked = describeDesktopSessionEvent({
      kind: "session_ended",
      reason: "overlay_incomplete",
      unlockedByUs: true,
      relocked: false,
      mode: "foreground",
    })!;
    expect(notLocked.text).toContain("有一块屏幕没能盖上遮罩");
    expect(notLocked.text).not.toContain("锁回去了");
    expect(notLocked.feishu).toBeNull();
  });

  it("session_ended 且 reason=secure_desktop（操作中弹出 UAC 之类的系统安全提示，AI 已停手）：写任务流 + 推飞书——这种弹窗只有用户本人能点，用户不在电脑前就会一直挂着", () => {
    const n = describeDesktopSessionEvent({ kind: "session_ended", reason: "secure_desktop" })!;
    expect(n.text).toContain("系统安全提示");
    expect(n.text).toContain("UAC");
    expect(n.text).toContain("亲自处理");
    expect(n.text).toContain("不会替你点");
    expect(n.feishu).toContain("{task}");
    expect(n.feishu).toContain("系统安全提示");
    expect(n.feishu).toContain("不会替你点");
    expect(n.feishu).toContain("回到电脑前处理后再让 AI 继续");
    // 电脑不是我们解锁的（用户本来就在用）：不提「没有锁回去」，免得吓人
    expect(n.text).not.toContain("没有重新锁上");
    expect(n.feishu).not.toContain("没有重新锁上");
  });

  it("secure_desktop 且电脑是我们解锁的：多说一句「没有重新锁上」——会话收尾不再锁屏（用户要处理弹窗），人不在的话电脑就敞着，必须让他知道；只认严格的 true", () => {
    const n = describeDesktopSessionEvent({ kind: "session_ended", reason: "secure_desktop", unlockedByUs: true })!;
    expect(n.text).toContain("原本是锁屏的");
    expect(n.text).toContain("没有重新锁上");
    expect(n.text).toContain("手动锁屏");
    expect(n.feishu).toContain("{task}");
    expect(n.feishu).toContain("没有重新锁上");
    expect(n.feishu).toContain("手动锁屏");
    for (const unlockedByUs of [false, undefined, null, 1, "true", "yes"]) {
      const g = describeDesktopSessionEvent({ kind: "session_ended", reason: "secure_desktop", unlockedByUs })!;
      expect(g.text, String(unlockedByUs)).not.toContain("没有重新锁上");
      expect(g.feishu, String(unlockedByUs)).not.toContain("没有重新锁上");
    }
  });

  it("session_ended 的 mode 字段不影响文案（后台 / 前台会话的空闲超时说法一致）", () => {
    for (const mode of ["background", "foreground", undefined]) {
      expect(describeDesktopSessionEvent({ kind: "session_ended", reason: "idle", mode })!.text, String(mode)).toContain("长时间没有新动作");
    }
  });

  it("瞬态 / 不认识 / 畸形载荷 → null（不展示）", () => {
    for (const data of [{ kind: "unlocking" }, { kind: "whatever" }, { kind: 3 }, {}, null, undefined, "str", [], 5]) {
      expect(describeDesktopSessionEvent(data), JSON.stringify(data)).toBeNull();
    }
  });

  it("error 文字限长 120 字符", () => {
    const n = describeDesktopSessionEvent({ kind: "relock_failed", error: "e".repeat(500) })!;
    expect(n.text).toContain("e".repeat(120) + "…");
    expect(n.text).not.toContain("e".repeat(121));
  });
});

describe("handleDesktopSessionEvent", () => {
  it("unlocked：写任务事件（info + meta 标注来源）并推飞书（{task} 换成任务名）", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "unlocked" }, r.deps);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ taskId: "t1", meta: { source: "desktop", subkind: "unlocked" } });
    expect(r.events[0]!.text).toContain("自动解锁");
    expect(r.feishu).toHaveLength(1);
    expect(r.feishu[0]).toContain("（任务「整理发票」）");
    expect(r.feishu[0]).not.toContain("{task}");
  });

  it("user_took_over：只写任务事件，不推飞书", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "user_took_over" }, r.deps);
    expect(r.events).toHaveLength(1);
    expect(r.feishu).toEqual([]);
  });

  it("background_started：写任务事件（subkind 标注），不推飞书；foreground_started 什么都不写", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "background_started" }, r.deps);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ taskId: "t1", meta: { source: "desktop", subkind: "background_started" } });
    expect(r.events[0]!.text).toContain("锁屏后台模式");
    expect(r.feishu).toEqual([]);

    const up = recorder();
    await handleDesktopSessionEvent("t1", { kind: "foreground_started" }, up.deps);
    expect(up.titles).toEqual([]);
    expect(up.events).toEqual([]);
    expect(up.feishu).toEqual([]);
  });

  it("user_took_over 且电脑是我们解锁的：写任务事件 + 推飞书（带任务名）；没有归属任务 / 任务已删也照推（安全提醒）", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "user_took_over", unlockedByUs: true }, r.deps);
    expect(r.events).toHaveLength(1);
    expect(r.feishu).toHaveLength(1);
    expect(r.feishu[0]).toContain("（任务「整理发票」）");
    expect(r.feishu[0]).toContain("请尽快手动锁屏");

    const noTask = recorder();
    await handleDesktopSessionEvent("_", { kind: "user_took_over", unlockedByUs: true }, noTask.deps);
    expect(noTask.events).toEqual([]);
    expect(noTask.feishu).toHaveLength(1);
    expect(noTask.feishu[0]).not.toContain("任务「");

    const gone = recorder({});
    await handleDesktopSessionEvent("gone-task", { kind: "user_took_over", unlockedByUs: true }, gone.deps);
    expect(gone.events).toEqual([]);
    expect(gone.feishu).toHaveLength(1);
  });

  it("session_ended / secure_desktop：写任务事件（subkind 标注）+ 推飞书（带任务名）；没有归属任务 / 任务已删也照推（不带任务名）", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "session_ended", reason: "secure_desktop" }, r.deps);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ taskId: "t1", meta: { source: "desktop", subkind: "session_ended" } });
    expect(r.events[0]!.text).toContain("系统安全提示");
    expect(r.feishu).toHaveLength(1);
    expect(r.feishu[0]).toContain("（任务「整理发票」）");
    expect(r.feishu[0]).not.toContain("{task}");

    const noTask = recorder();
    await handleDesktopSessionEvent("_", { kind: "session_ended", reason: "secure_desktop", unlockedByUs: true }, noTask.deps);
    expect(noTask.events).toEqual([]);
    expect(noTask.feishu).toHaveLength(1);
    expect(noTask.feishu[0]).toContain("没有重新锁上");
    expect(noTask.feishu[0]).not.toContain("任务「");

    const gone = recorder({});
    await handleDesktopSessionEvent("gone-task", { kind: "session_ended", reason: "secure_desktop" }, gone.deps);
    expect(gone.events).toEqual([]);
    expect(gone.feishu).toHaveLength(1);
  });

  it("不展示的事件：什么都不做（连任务标题都不查）", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("t1", { kind: "unlocking" }, r.deps);
    await handleDesktopSessionEvent("t1", { kind: "session_ended", reason: "explicit" }, r.deps);
    expect(r.titles).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.feishu).toEqual([]);
  });

  it("任务已不存在：不往不存在的任务里写事件；但安全相关提醒（锁不回去）仍然推飞书，只是不带任务名", async () => {
    const r = recorder({});
    await handleDesktopSessionEvent("gone-task", { kind: "relock_failed", error: "boom" }, r.deps);
    expect(r.events).toEqual([]);
    expect(r.feishu).toHaveLength(1);
    expect(r.feishu[0]).toContain("没能自动锁回去：boom");
    expect(r.feishu[0]).not.toContain("任务「");
    expect(r.feishu[0]).not.toContain("{task}");
  });

  it("没有归属任务（taskId = _）：不查标题、不写事件，但 relock_failed 仍推飞书", async () => {
    const r = recorder();
    await handleDesktopSessionEvent("_", { kind: "relock_failed" }, r.deps);
    expect(r.titles).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.feishu).toHaveLength(1);
    // 非安全类事件在没有任务时无处可写、也不推：user_took_over
    const r2 = recorder();
    await handleDesktopSessionEvent("_", { kind: "user_took_over" }, r2.deps);
    expect(r2.events).toEqual([]);
    expect(r2.feishu).toEqual([]);
  });

  it("非法 taskId（路径穿越 / 空 / 超长 / 非字符串）一律忽略", async () => {
    const r = recorder({ "../x": "evil", "a b": "evil" });
    for (const id of ["../x", "a b", "", "x".repeat(201), 123, null, undefined]) {
      await handleDesktopSessionEvent(id, { kind: "relock_failed" }, r.deps);
    }
    expect(r.titles).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.feishu).toEqual([]);
  });

  it("任务标题含换行 / 超长：单行化并截到 40 字符再放进飞书", async () => {
    const r = recorder({ t1: `第一行\n${"很长".repeat(50)}` });
    await handleDesktopSessionEvent("t1", { kind: "relocked" }, r.deps);
    const msg = r.feishu[0]!;
    expect(msg).not.toContain("\n");
    const title = /任务「(.*)」/.exec(msg)![1]!;
    expect(title.length).toBe(40);
  });

  it("任一步失败只记 warn、不抛、不影响另一步：标题读失败 → 仍推飞书；写事件失败 → 仍推飞书；飞书失败 → 事件已写", async () => {
    const a = recorder({}, { taskTitle: async () => { throw new Error("磁盘坏了"); } });
    await expect(handleDesktopSessionEvent("t1", { kind: "relocked" }, a.deps)).resolves.toBeUndefined();
    expect(a.events).toEqual([]); // 标题没读到 = 不写
    expect(a.feishu).toHaveLength(1);
    expect(a.warns.join("\n")).toContain("磁盘坏了");

    const b = recorder({ t1: "T" }, { writeTaskEvent: async () => { throw new Error("写不进去"); } });
    await expect(handleDesktopSessionEvent("t1", { kind: "relocked" }, b.deps)).resolves.toBeUndefined();
    expect(b.feishu).toHaveLength(1);
    expect(b.warns.join("\n")).toContain("写不进去");

    const c = recorder({ t1: "T" }, { notifyOwner: async () => { throw new Error("飞书断了"); } });
    await expect(handleDesktopSessionEvent("t1", { kind: "relocked" }, c.deps)).resolves.toBeUndefined();
    expect(c.events).toHaveLength(1);
    expect(c.warns.join("\n")).toContain("飞书断了");
  });
});

describe("会话结束类事件清掉「可能开着会话」的登记（停止钩子靠它决定要不要通知主进程）", () => {
  afterEach(() => __resetDesktopOpenSessionsForTest());

  const endings: Array<[string, Record<string, unknown>]> = [
    ["session_ended（任何原因，含不展示的正常结束）", { kind: "session_ended", reason: "explicit" }],
    ["session_ended 异常结束", { kind: "session_ended", reason: "idle" }],
    ["user_took_over", { kind: "user_took_over" }],
    ["后台操作时用户解了锁（session_ended / unlocked_externally）", { kind: "session_ended", reason: "unlocked_externally", mode: "background" }],
    ["操作中弹出 UAC 之类的系统安全提示（session_ended / secure_desktop）", { kind: "session_ended", reason: "secure_desktop", unlockedByUs: true }],
    ["操作中遮罩盖不全被结束（session_ended / overlay_incomplete）", { kind: "session_ended", reason: "overlay_incomplete", unlockedByUs: true, relocked: true }],
    ["unlock_failed（会话根本没开起来）", { kind: "unlock_failed", error: "x" }],
    ["开会话中途遮罩没盖上被撤销（relocked / overlay_failed）", { kind: "relocked", reason: "overlay_failed" }],
    ["开会话中途遮罩没盖上且锁不回去（relock_failed / overlay_failed）", { kind: "relock_failed", reason: "overlay_failed", error: "x" }],
    ["解锁时被取消（relocked / cancelled）", { kind: "relocked", reason: "cancelled" }],
  ];

  it.each(endings)("%s → 清掉", async (_name, data) => {
    markDesktopSessionOpen("t1");
    markDesktopSessionOpen("t2");
    await handleDesktopSessionEvent("t1", data, recorder().deps);
    expect(hasOpenDesktopSession("t1")).toBe(false);
    expect(hasOpenDesktopSession("t2")).toBe(true); // 只清事件所属的任务
  });

  it.each([
    ["unlocking", { kind: "unlocking" }],
    ["unlocked", { kind: "unlocked" }],
    ["background_started（后台档开始：会话刚开着）", { kind: "background_started" }],
    ["foreground_started（后台档升级成前台档：会话仍开着）", { kind: "foreground_started" }],
    ["正常结束时的 relocked（task_done）", { kind: "relocked", reason: "task_done" }],
    ["不认识的事件", { kind: "whatever" }],
    ["畸形载荷", "str"],
  ])("%s → 不动登记", async (_name, data) => {
    markDesktopSessionOpen("t1");
    await handleDesktopSessionEvent("t1", data, recorder().deps);
    expect(hasOpenDesktopSession("t1")).toBe(true);
  });

  it("没有归属任务（_）/ 非法 taskId 的事件不碰登记；任务不存在、写事件失败也照样清（清登记在一切异步之前）", async () => {
    markDesktopSessionOpen("t1");
    await handleDesktopSessionEvent("_", { kind: "session_ended" }, recorder().deps);
    await handleDesktopSessionEvent("../t1", { kind: "session_ended" }, recorder().deps);
    expect(hasOpenDesktopSession("t1")).toBe(true);

    const broken = recorder({ t1: "T" }, { taskTitle: async () => { throw new Error("磁盘坏了"); } });
    await handleDesktopSessionEvent("t1", { kind: "session_ended" }, broken.deps);
    expect(hasOpenDesktopSession("t1")).toBe(false);
  });

  it("清登记发生在处理器的同步部分：事件一到达（还没来得及 await）登记就已经清了，不会晚于该任务下一次开会话的登记", () => {
    markDesktopSessionOpen("t1");
    const p = handleDesktopSessionEvent("t1", { kind: "session_ended", reason: "idle" }, recorder().deps);
    expect(hasOpenDesktopSession("t1")).toBe(false); // 同步断言：promise 还没落定
    markDesktopSessionOpen("t1"); // 模拟紧接着的下一次开会话
    return p.then(() => expect(hasOpenDesktopSession("t1")).toBe(true));
  });
});

describe("ensureDesktopSessionEventsRegistered（挂在 bridge 的 evt 上）", () => {
  let fake: FakeBrowser | null = null;
  afterEach(() => {
    fake?.cleanup();
    fake = null;
    vi.restoreAllMocks();
  });

  const install = () => {
    fake = installFakeBrowser({}, { capabilities: ["browser.v1", "desktop.v1"] });
    return fake;
  };
  /** 事件处理是异步的（bridge 只管把 evt 派给回调）：等记录器收到 */
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("没有 bridge（无 IPC 通道）→ 什么都不做，不抛", () => {
    expect(() => ensureDesktopSessionEventsRegistered(recorder().deps)).not.toThrow();
  });

  it("事件名固定为 desktop_session；收到事件 → 走处理器", async () => {
    expect(DESKTOP_SESSION_EVENT).toBe("desktop_session");
    const f = install();
    const r = recorder();
    ensureDesktopSessionEventsRegistered(r.deps);
    f.emitEvent("desktop_session", "t1", { kind: "relocked" });
    await settle();
    expect(r.events).toHaveLength(1);
    expect(r.feishu).toHaveLength(1);
  });

  it("按 bridge 实例幂等：重复注册只会处理一次", async () => {
    const f = install();
    const r = recorder();
    ensureDesktopSessionEventsRegistered(r.deps);
    ensureDesktopSessionEventsRegistered(r.deps);
    ensureDesktopSessionEventsRegistered(recorder().deps); // 换依赖也不会再挂第二份
    f.emitEvent("desktop_session", "t1", { kind: "unlocked" });
    await settle();
    expect(r.events).toHaveLength(1);
    expect(r.feishu).toHaveLength(1);
  });

  it("换了 bridge 实例（桌面端重启后新连接）→ 在新实例上重新注册", async () => {
    const first = install();
    const r1 = recorder();
    ensureDesktopSessionEventsRegistered(r1.deps);
    first.cleanup();
    const second = install();
    const r2 = recorder();
    ensureDesktopSessionEventsRegistered(r2.deps);
    second.emitEvent("desktop_session", "t1", { kind: "relocked" });
    await settle();
    expect(r1.events).toEqual([]);
    expect(r2.events).toHaveLength(1);
  });

  it("注册之前到达的事件由 bridge 的缓冲补发（会话创建比第一条事件晚也不丢）", async () => {
    const f = install();
    f.emitEvent("desktop_session", "t1", { kind: "unlocked" });
    const r = recorder();
    ensureDesktopSessionEventsRegistered(r.deps);
    await settle();
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.meta).toMatchObject({ subkind: "unlocked" });
  });

  it("经 bridge 到达的 session_ended 事件会清掉任务的「可能开着会话」登记", async () => {
    const f = install();
    ensureDesktopSessionEventsRegistered(recorder().deps);
    markDesktopSessionOpen("t1");
    f.emitEvent("desktop_session", "t1", { kind: "session_ended", reason: "explicit" });
    await settle();
    expect(hasOpenDesktopSession("t1")).toBe(false);
  });

  it("其它事件名不会触发处理器", async () => {
    const f = install();
    const r = recorder();
    ensureDesktopSessionEventsRegistered(r.deps);
    f.emitEvent("browser_settings", "t1", { kind: "relocked" });
    f.emitEvent("desktop_sessionX", "t1", { kind: "relocked" });
    await settle();
    expect(r.events).toEqual([]);
    expect(r.feishu).toEqual([]);
  });
});
