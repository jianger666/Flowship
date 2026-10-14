/**
 * group-roster：群成员 / 群历史拉取 + 缓存（全程 mock lark exec，合成数据）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetGroupRosterForTest,
  fetchGroupRoster,
  fetchRecentGroupMessages,
  learnGroupMember,
  lookupGroupMemberName,
} from "@/lib/server/feishu-bridge/group-roster";
import {
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  __setLarkRetryBaseForTest,
} from "@/lib/server/feishu-bridge/lark-api";

type Call = string[];
let calls: Call[] = [];

const membersJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    data: {
      users: [
        { member_id: "ou_u1", name: "张三", tenant_key: "t" },
        { member_id: "ou_u2", name: "李四", tenant_key: "t" },
      ],
      bots: [
        { app_id: "cli_b1", member_id: "ou_b1", name: "测试机器人", tenant_key: "t" },
      ],
      bot_total: 1,
      user_total: 2,
      has_more: false,
      ...over,
    },
  });

const mockExec = (
  handler: (args: string[]) => { stdout?: string; stderr?: string } | Promise<{ stdout?: string; stderr?: string }>,
) => {
  __setLarkExecForTest(async (_bin, args) => {
    calls.push(args);
    const r = await handler(args);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  });
};

beforeEach(() => {
  calls = [];
  __resetGroupRosterForTest();
  __setLarkRetryBaseForTest(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
  __setLarkRetryBaseForTest(null);
});

describe("fetchGroupRoster", () => {
  it("合并 users + bots，区分 kind，并带正确的命令参数", async () => {
    mockExec(() => ({ stdout: membersJson() }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.source).toBe("api");
    expect(r.chatId).toBe("oc_1");
    expect(r.members).toEqual([
      { openId: "ou_u1", name: "张三", kind: "user" },
      { openId: "ou_u2", name: "李四", kind: "user" },
      { openId: "ou_b1", name: "测试机器人", kind: "bot" },
    ]);
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(["im", "+chat-members-list"]);
    expect(args).toContain("--page-all");
    expect(args[args.indexOf("--as") + 1]).toBe("user");
    expect(args[args.indexOf("--chat-id") + 1]).toBe("oc_1");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
  });

  it("stdout 混进度行也能解析", async () => {
    mockExec(() => ({
      stdout: `[page 1] fetching...\n${membersJson()}\n[page 1] done`,
      stderr: "[page 1] fetching...\n",
    }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.source).toBe("api");
    expect(r.members).toHaveLength(3);
  });

  it("缺字段 / 脏元素不抛：跳过没 open_id 的、名字缺失为空串", async () => {
    mockExec(() => ({
      stdout: JSON.stringify({
        ok: true,
        data: {
          users: [{ member_id: "ou_a" }, { name: "无id" }, null, "x"],
          bots: [{ open_id: "ou_bb", name: "改名字段" }],
        },
      }),
    }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.members).toEqual([
      { openId: "ou_a", name: "", kind: "user" },
      { openId: "ou_bb", name: "改名字段", kind: "bot" },
    ]);
  });

  it("has_more 为真（被截断）不抛，并并入 learned 里漏掉的人", async () => {
    learnGroupMember("oc_1", { openId: "ou_late", name: "后来者", kind: "user" });
    mockExec(() => ({ stdout: membersJson({ has_more: true, page_token: "p2" }) }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.source).toBe("api");
    expect(r.members.map((m) => m.openId)).toEqual(["ou_u1", "ou_u2", "ou_b1", "ou_late"]);
  });

  it("未截断时不并入 learned（api 是权威）", async () => {
    learnGroupMember("oc_1", { openId: "ou_gone", name: "已退群", kind: "user" });
    mockExec(() => ({ stdout: membersJson() }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.members.map((m) => m.openId)).not.toContain("ou_gone");
  });

  it("TTL 内命中缓存，过期后重拉，force 跳过缓存", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    mockExec(() => ({ stdout: membersJson() }));
    await fetchGroupRoster("oc_1");
    await fetchGroupRoster("oc_1");
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(4 * 60_000);
    await fetchGroupRoster("oc_1");
    expect(calls).toHaveLength(1);
    await fetchGroupRoster("oc_1", { force: true });
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await fetchGroupRoster("oc_1");
    expect(calls).toHaveLength(3);
  });

  it("不同 chatId 各自缓存", async () => {
    mockExec(() => ({ stdout: membersJson() }));
    await fetchGroupRoster("oc_1");
    await fetchGroupRoster("oc_2");
    expect(calls).toHaveLength(2);
  });

  it("同 chatId 并发共享同一个 in-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockExec(async () => {
      await gate;
      return { stdout: membersJson() };
    });
    const p1 = fetchGroupRoster("oc_1");
    const p2 = fetchGroupRoster("oc_1");
    const p3 = fetchGroupRoster("oc_1");
    release();
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(calls).toHaveLength(1);
    expect(a.members).toEqual(b.members);
    expect(b.members).toEqual(c.members);
  });

  it("失败 → none，60 秒负缓存内不重试，之后重试", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    mockExec(() => ({
      stdout: JSON.stringify({ ok: false, error: { message: "no scope", code: 99991672 } }),
    }));
    const r1 = await fetchGroupRoster("oc_1");
    expect(r1).toMatchObject({ source: "none", members: [] });
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(59_000);
    const r2 = await fetchGroupRoster("oc_1");
    expect(r2.source).toBe("none");
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    await fetchGroupRoster("oc_1");
    expect(calls).toHaveLength(2);
  });

  it("exec 直接 reject 也不抛", async () => {
    __setLarkExecForTest(async () => {
      throw new Error("spawn ENOENT");
    });
    await expect(fetchGroupRoster("oc_1")).resolves.toMatchObject({ source: "none" });
  });

  it("成功但解析不出任何成员 → 按失败降级", async () => {
    mockExec(() => ({ stdout: JSON.stringify({ ok: true, data: { foo: 1 } }) }));
    const r = await fetchGroupRoster("oc_1");
    expect(r.source).toBe("none");
  });

  it("失败时回退 learned，负缓存期间 learned 新增也可见；force 可立刻重试", async () => {
    learnGroupMember("oc_1", { openId: "ou_l1", name: "见过的人", kind: "user" });
    let fail = true;
    mockExec(() => (fail ? { stdout: "not json" } : { stdout: membersJson() }));
    const r1 = await fetchGroupRoster("oc_1");
    expect(r1.source).toBe("learned");
    expect(r1.members).toEqual([{ openId: "ou_l1", name: "见过的人", kind: "user" }]);
    learnGroupMember("oc_1", { openId: "ou_l2", name: "新见的", kind: "bot" });
    const r2 = await fetchGroupRoster("oc_1");
    expect(r2.members.map((m) => m.openId)).toEqual(["ou_l1", "ou_l2"]);
    expect(calls).toHaveLength(1);
    fail = false;
    const r3 = await fetchGroupRoster("oc_1", { force: true });
    expect(r3.source).toBe("api");
  });

  it("返回的是副本：改它不污染缓存", async () => {
    mockExec(() => ({ stdout: membersJson() }));
    const r1 = await fetchGroupRoster("oc_1");
    r1.members[0].name = "被改了";
    const r2 = await fetchGroupRoster("oc_1");
    expect(r2.members[0].name).toBe("张三");
  });
});

describe("learnGroupMember / lookupGroupMemberName", () => {
  it("查不到返回 undefined；learned 可查", () => {
    expect(lookupGroupMemberName("oc_1", "ou_x")).toBeUndefined();
    learnGroupMember("oc_1", { openId: "ou_x", name: "小明", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "ou_x")).toBe("小明");
    expect(lookupGroupMemberName("oc_2", "ou_x")).toBeUndefined();
  });

  it("空名字条目不产出名字，后来的非空名字补上", () => {
    learnGroupMember("oc_1", { openId: "ou_x", name: "", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "ou_x")).toBeUndefined();
    learnGroupMember("oc_1", { openId: "ou_x", name: "补名", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "ou_x")).toBe("补名");
  });

  it("空名字不覆盖 learned 已有的名字", () => {
    learnGroupMember("oc_1", { openId: "ou_x", name: "原名", kind: "user" });
    learnGroupMember("oc_1", { openId: "ou_x", name: "", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "ou_x")).toBe("原名");
  });

  it("不覆盖 api 来源的非空名字；api 名字为空时补上；缓存命中的 roster 同步", async () => {
    mockExec(() =>
      ({
        stdout: JSON.stringify({
          ok: true,
          data: {
            users: [
              { member_id: "ou_a", name: "API名" },
              { member_id: "ou_e", name: "" },
            ],
            bots: [],
          },
        }),
      }),
    );
    await fetchGroupRoster("oc_1");
    learnGroupMember("oc_1", { openId: "ou_a", name: "入向名", kind: "user" });
    learnGroupMember("oc_1", { openId: "ou_e", name: "补上的名", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "ou_a")).toBe("API名");
    expect(lookupGroupMemberName("oc_1", "ou_e")).toBe("补上的名");
    const r = await fetchGroupRoster("oc_1");
    expect(r.members.find((m) => m.openId === "ou_a")?.name).toBe("API名");
    expect(r.members.find((m) => m.openId === "ou_e")?.name).toBe("补上的名");
  });

  it("api 缓存过期后 lookup 仍能同步查到最近一次 api 数据", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    mockExec(() => ({ stdout: membersJson() }));
    await fetchGroupRoster("oc_1");
    vi.advanceTimersByTime(10 * 60_000);
    expect(lookupGroupMemberName("oc_1", "ou_b1")).toBe("测试机器人");
  });

  it("空 openId 被忽略", () => {
    learnGroupMember("oc_1", { openId: "", name: "x", kind: "user" });
    expect(lookupGroupMemberName("oc_1", "")).toBeUndefined();
  });
});

const msg = (over: Record<string, unknown>) => ({
  chat_id: "oc_1",
  content: "hi",
  create_time: "2026-10-14 10:00",
  deleted: false,
  mentions: [],
  message_id: "om_x",
  msg_type: "text",
  sender: { id: "ou_u1", id_type: "open_id", name: "张三", sender_type: "user" },
  ...over,
});

const historyJson = (messages: unknown[]) =>
  JSON.stringify({ ok: true, data: { messages } });

describe("fetchRecentGroupMessages", () => {
  it("desc 输入 → 旧→新输出；命令参数正确", async () => {
    mockExec(() => ({
      stdout: historyJson([
        msg({ message_id: "om_3", create_time: "2026-10-14 10:03" }),
        msg({ message_id: "om_2", create_time: "2026-10-14 10:02" }),
        msg({ message_id: "om_1", create_time: "2026-10-14 10:01" }),
      ]),
    }));
    const r = await fetchRecentGroupMessages("oc_1", 5);
    expect(r.map((m) => m.messageId)).toEqual(["om_1", "om_2", "om_3"]);
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(["im", "+chat-messages-list"]);
    expect(args[args.indexOf("--order") + 1]).toBe("desc");
    expect(args[args.indexOf("--page-size") + 1]).toBe("5");
    expect(args[args.indexOf("--as") + 1]).toBe("user");
    expect(args).toContain("--no-reactions");
  });

  it("默认 limit=20", async () => {
    mockExec(() => ({ stdout: historyJson([msg({})]) }));
    await fetchRecentGroupMessages("oc_1");
    expect(calls[0][calls[0].indexOf("--page-size") + 1]).toBe("20");
  });

  it("sender 映射：app→bot(优先 open_bot_id)、user→user、其它→unknown", async () => {
    mockExec(() => ({
      stdout: historyJson([
        msg({
          message_id: "om_app",
          sender: { id: "cli_app1", id_type: "app_id", name: "机器人甲", open_bot_id: "ou_bot1", sender_type: "app" },
        }),
        msg({
          message_id: "om_app2",
          sender: { id: "cli_app2", id_type: "app_id", name: "机器人乙", sender_type: "app" },
        }),
        msg({ message_id: "om_user" }),
        msg({
          message_id: "om_sys",
          sender: { id: "sys", name: "", sender_type: "system" },
        }),
        msg({ message_id: "om_nosender", sender: undefined }),
      ]),
    }));
    const r = await fetchRecentGroupMessages("oc_1");
    const by = Object.fromEntries(r.map((m) => [m.messageId, m]));
    expect(by.om_app).toMatchObject({ senderKind: "bot", senderOpenId: "ou_bot1", senderName: "机器人甲" });
    expect(by.om_app2).toMatchObject({ senderKind: "bot", senderOpenId: "cli_app2" });
    expect(by.om_user).toMatchObject({ senderKind: "user", senderOpenId: "ou_u1", senderName: "张三" });
    expect(by.om_sys.senderKind).toBe("unknown");
    expect(by.om_nosender).toMatchObject({ senderKind: "unknown", senderOpenId: "", senderName: "" });
  });

  it("deleted:true 的丢掉", async () => {
    mockExec(() => ({
      stdout: historyJson([
        msg({ message_id: "om_del", deleted: true }),
        msg({ message_id: "om_ok" }),
      ]),
    }));
    const r = await fetchRecentGroupMessages("oc_1");
    expect(r.map((m) => m.messageId)).toEqual(["om_ok"]);
  });

  it("mention 空名用 roster 缓存按 open_id 补，补不到留空串；字段原样映射", async () => {
    learnGroupMember("oc_1", { openId: "ou_known", name: "已知人", kind: "user" });
    mockExec(() => ({
      stdout: historyJson([
        msg({
          message_id: "om_m",
          msg_type: "post",
          content: "<card>\nx\n</card>",
          create_time: "2026-10-14 16:29",
          mentions: [
            { id: "ou_known", key: "@_user_1", name: "" },
            { id: "ou_unknown", key: "@_user_2", name: "" },
            { id: "ou_named", key: "@_user_3", name: "自带名" },
            { key: "@_user_4", name: "无id" },
          ],
        }),
      ]),
    }));
    const [m] = await fetchRecentGroupMessages("oc_1");
    expect(m.mentions).toEqual([
      { openId: "ou_known", name: "已知人" },
      { openId: "ou_unknown", name: "" },
      { openId: "ou_named", name: "自带名" },
    ]);
    expect(m).toMatchObject({
      msgType: "post",
      content: "<card>\nx\n</card>",
      createTime: "2026-10-14 16:29",
    });
  });

  it("stdout 混进度行也能解析", async () => {
    mockExec(() => ({ stdout: `[page 1] fetching...\n${historyJson([msg({})])}\n` }));
    expect(await fetchRecentGroupMessages("oc_1")).toHaveLength(1);
  });

  it("失败返回 []（不抛），且不缓存失败", async () => {
    let fail = true;
    mockExec(() =>
      fail
        ? { stdout: JSON.stringify({ ok: false, error: { message: "boom" } }) }
        : { stdout: historyJson([msg({})]) },
    );
    expect(await fetchRecentGroupMessages("oc_1")).toEqual([]);
    fail = false;
    expect(await fetchRecentGroupMessages("oc_1")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("缺 messages 字段 → []", async () => {
    mockExec(() => ({ stdout: JSON.stringify({ ok: true, data: {} }) }));
    expect(await fetchRecentGroupMessages("oc_1")).toEqual([]);
  });

  it("15 秒短缓存：同 chatId+limit 命中，不同 limit 不共用，过期重拉", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    mockExec(() => ({ stdout: historyJson([msg({})]) }));
    await fetchRecentGroupMessages("oc_1", 10);
    await fetchRecentGroupMessages("oc_1", 10);
    expect(calls).toHaveLength(1);
    await fetchRecentGroupMessages("oc_1", 5);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(16_000);
    await fetchRecentGroupMessages("oc_1", 10);
    expect(calls).toHaveLength(3);
  });

  it("并发去重", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockExec(async () => {
      await gate;
      return { stdout: historyJson([msg({})]) };
    });
    const ps = [
      fetchRecentGroupMessages("oc_1", 10),
      fetchRecentGroupMessages("oc_1", 10),
    ];
    release();
    const [a, b] = await Promise.all(ps);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });
});
