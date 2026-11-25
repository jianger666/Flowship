/**
 * 非属主轮标记的寿命以「run 还活着」为准（第二轮评审 P1-5），以及「中途补登」标记（P0 的基础设施）。
 *
 * 漏洞链（修前）：标记的滑动 TTL 只在 Flowship 工具调用时续期。Cursor 后端 agent 自带的 shell 跑一条超过 TTL 的长命令
 *（`sleep 2800 && …`）期间没有任何 Flowship 工具调用，标记就过期了，之后 desktop_* 和恒拒清单（写所有者备注 / 新建定时 /
 * 自动推进 / 浏览器登录态与页面脚本）全部放行——群成员一句话就能让 agent 先睡 47 分钟再动电脑。
 *
 * 现在：标记过期时先问「这个 task 的 run 还活着吗」（task-stream 登记 task 探针、chat-runner 登记 chat 探针），活着就续、不过期。
 * 这里用**真实**的 guard + 真实的 flowship-tools 咽喉 + 真实的 task-stream（验证探针真的登记在 runningTasks 上）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { blockAfter, readSource } from "./helpers/source-text";

const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { DESKTOP_NON_OWNER_DENIED } = await import("@/lib/server/desktop/tools");
const guard = await import("@/lib/server/non-owner-turn-guard");
const { runningTasks } = await import("@/lib/server/task-stream");
const { bindSessionToken } = await import("./helpers/session-token");

const TEST_PROBE = "test-probe";

afterEach(() => {
  vi.useRealTimers();
  guard.__setNonOwnerRunProbeForTest(TEST_PROBE, null);
  guard.__resetNonOwnerTurnGuardForTest();
  runningTasks.clear();
});

const mkTool = (name: string) => {
  const handler = vi.fn(async () => ({
    content: [{ type: "text" as const, text: `HANDLED:${name}` }],
  }));
  return {
    tool: { name, label: name, description: "", parameters: {} as never, handler } as never,
    handler,
  };
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");
const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-04T${hhmm}:00Z`));
const call = (tool: never, args: Record<string, unknown>, taskId: string) => {
  // 过期会话闸（第十八轮）：标记放行的调用还要求 token 是该任务当前会话的——每次调用前把 "tok" 登记成当前会话
  bindSessionToken(taskId);
  return invokeFlowshipTool(tool, args, "tok", { taskId } as never);
};

describe("run 还活着：标记不因「久没调 Flowship 工具」而过期", () => {
  it("评审里的链条：同权轮 + 长 shell 命令（50 分钟没有 Flowship 工具调用）之后，desktop_* 与恒拒清单照样被拒", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, (id) => id === "t1"); // t1 的 run 一直在跑
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    at("10:50"); // 距起点 50 分钟、没有任何 touch：修前这里已过期

    const shot = mkTool("desktop_screenshot");
    expect(textOf(await call(shot.tool, {}, "t1"))).toBe(DESKTOP_NON_OWNER_DENIED);
    expect(shot.handler).not.toHaveBeenCalled();
    for (const [name, args] of [
      ["set_owner_note", {}],
      ["schedule", { action: "create" }],
      ["advance_next", {}],
      ["browser_storage", {}],
      ["browser_evaluate", {}],
    ] as const) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, { ...args }, "t1")), name).toContain("[DENIED]");
      expect(t.handler, name).not.toHaveBeenCalled();
    }
  });

  it("scope=all 的标记同样：系统工具整体硬拒不会因为 run 里跑了条长命令就放行", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => true);
    guard.beginNonOwnerTurn("t1");
    at("11:30");
    const sw = mkTool("submit_work");
    expect(textOf(await call(sw.tool, { task_id: "t1" }, "t1"))).toContain("[DENIED]");
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
  });

  it("run 一结束（探针答「不在」）就回到 TTL 兜底：漏清的标记照旧会过期、属主不会被永久误拒", async () => {
    vi.useFakeTimers();
    at("10:00");
    let alive = true;
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => alive);
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    at("10:50");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    alive = false;
    at("11:40"); // 距上次被探针续期（10:50）又过了 50 分钟
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
    const shot = mkTool("desktop_screenshot");
    expect(textOf(await call(shot.tool, {}, "t1"))).toBe("HANDLED:desktop_screenshot");
  });

  it("探针只回答自己那个 task：别的 task 的 run 在跑不会让这个 task 的漏标记续命", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, (id) => id === "other");
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    at("10:50");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("探针抛错：按「还活着」算（fail-closed），不是放行", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => {
      throw new Error("probe broke");
    });
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    at("10:50");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
  });

  it("绝对上限：标记再「活」也不超过 25 小时（漏清的标记碰上后继的活 run 不会永生）", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => true);
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    // 每 30 分钟被探针续一次，一路到 24h59m 都还在
    for (let min = 30; min <= 24 * 60 + 59; min += 30) {
      vi.setSystemTime(new Date(Date.parse("2026-11-04T10:00:00Z") + min * 60_000));
      expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    }
    vi.setSystemTime(new Date(Date.parse("2026-11-04T10:00:00Z") + (25 * 60 + 1) * 60_000));
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("没有 run 在跑（探针都答「不在」）：行为与原来的 TTL 兜底一致", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    at("10:46");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });
});

describe("生产探针真的登记了", () => {
  it("task 探针 = runningTasks：run 在表里 → 标记过 TTL 仍在；run 出表 → 过 TTL 就没了", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t-prod", Date.now(), "desktop");
    runningTasks.set("t-prod", { instanceId: 1 } as never);
    at("10:50");
    expect(guard.isGroupNonOwnerTurnActive("t-prod")).toBe(true);
    runningTasks.delete("t-prod");
    at("11:40");
    expect(guard.isGroupNonOwnerTurnActive("t-prod")).toBe(false);
  });

  // 接线断言读**剥掉注释**的源码（注释里照抄一遍不算数）。
  // 「run 收尾清中途补登的标记」不再用源码正则证明（那是自证：正则对得上不代表 run 收尾时真的会执行）——
  // 改为走真实 run 收尾的运行时用例：task 侧 tests/foreign-content-turn-runner.test.ts「中途补登」、
  // chat 热路径 tests/chat-runner-foreign-marker-cleanup.test.ts「热路径」（后者同时覆盖 chat 探针让标记不因 TTL 过期）
  it("两个 runner 的探针登记在位（chat = runActive 或自动重连链在飞，不是「会话在表里」；task = runningTasks）", () => {
    const chat = readSource("src/lib/server/chat-runner.ts");
    expect(chat).toMatch(
      /registerNonOwnerRunProbe\("chat",\s*\(taskId\)\s*=>\s*runningChats\.get\(taskId\)\?\.runActive === true \|\| getReconnectStops\(\)\.has\(taskId\)\)/,
    );
    const stream = readSource("src/lib/server/task-stream.ts");
    expect(stream).toMatch(/registerNonOwnerRunProbe\("task",\s*\(taskId\)\s*=>\s*runningTasks\.has\(taskId\)\)/);
  });

  // chat 探针「重连链在飞也算在跑」（第十二轮评审 P2-1）成立的前提：重连链摘坏实例之前，停止闭包已经登记进 getReconnectStops——
  // 否则「摘表（runActive 没了）→ 闭包还没登记」之间有一段两头都答「没在跑」的缝。
  // 第十三轮评审 P3-3：原来的断言拿 `closing > called` 比的是**物理位置**（runReconnectAttempt 的定义排在 tryChatAutoReconnect 之后，所以恒成立，
  // 把摘表挪到登记之前它也不红），而且依赖整行字面量。现在按**函数体**分段：登记与唯一调用在 tryChatAutoReconnect 体内按先后比；
  // 以 reconnect 为由摘表的 closeChatSession 数得过来、全落在 runReconnectAttempt 体内（它只经上面那个调用到达）；登记之前的那一段不碰会话记录。
  // 仍然只是读剥掉注释的源码、只能防回退：行为靠 chat-runner-foreign-marker-cleanup 的真链路用例——
  // 首次退避窗口、「await getTask 窗口」（陈旧记录这时仍在表里、runActive 仍为真，探针靠它答「在跑」）、resume 回调时刻、递归、用户 stop 各一条。
  it("重连闭包先于摘坏实例登记：tryChatAutoReconnect 体内 getReconnectStops().set 早于 runReconnectAttempt 的唯一调用、登记之前不碰会话记录；以 reconnect 为由摘表的调用全在 runReconnectAttempt 体内；清除只在 finally 里、按身份删", () => {
    const src = readSource("src/lib/server/chat-runner.ts");
    const tryBody = blockAfter(src, "const tryChatAutoReconnect = async (");
    const attemptBody = blockAfter(src, "const runReconnectAttempt = async (");
    // 执行顺序（不是物理顺序）：登记 → 才调 runReconnectAttempt
    const registeredAt = tryBody.search(/getReconnectStops\(\)\s*\.set\(\s*task\.id\s*,\s*reconnectStop\s*\)/);
    const calledAt = tryBody.search(/\bawait runReconnectAttempt\(/);
    expect(registeredAt, "tryChatAutoReconnect 体内应登记停止闭包").toBeGreaterThan(-1);
    expect(calledAt, "tryChatAutoReconnect 体内应调 runReconnectAttempt").toBeGreaterThan(registeredAt);
    expect(src.match(/\brunReconnectAttempt\b/g)?.length, "runReconnectAttempt 只能被 tryChatAutoReconnect 调用（定义一处、调用一处）").toBe(2);
    // 登记之前（现状含 `await getTask` 的窗口）不碰会话记录：stale 记录一直还在表里
    // 第十四轮评审 P3-5 ⑦：这里原先还要求登记之前必含 `await getTask(`——把登记提到 getTask 之前（窗口消失，是更稳的修法）会被误红。
    // 窗口本身由 chat-runner-foreign-marker-cleanup 的「await getTask 窗口」行为用例钉着（登记提前时它照样绿），所以这里只管「不碰会话记录」
    const beforeRegister = tryBody.slice(0, registeredAt);
    expect(beforeRegister, "登记之前不得摘表 / 改 runActive").not.toMatch(/closeChatSession\(|runningChats\.(delete|set)\(|runActive\s*=\s*false/);
    // 以 reconnect 为由摘表的调用：全文件有几处，runReconnectAttempt 体内就有几处（都在登记之后才会执行）
    const closes = src.match(/reason: "reconnect"/g)?.length ?? 0;
    expect(closes, "以 reconnect 为由的摘表调用应当存在").toBeGreaterThan(0);
    expect(attemptBody.match(/reason: "reconnect"/g)?.length, "以 reconnect 为由的摘表调用不得出现在 runReconnectAttempt 之外").toBe(closes);
    // 清除：全文件只有一处 delete、在 tryChatAutoReconnect 自己的 finally 里、按身份删
    expect(src.match(/getReconnectStops\(\)\.delete\(/g)?.length).toBe(1);
    // 函数体里只有一个 finally，且它就是函数的收尾、里面只有「按身份删」这一件事。此前用惰性的 `[\s\S]*?` 找「某个 finally 之后任何位置的同形代码」，
    // 更早多出一个 finally 时也能过（第十六轮评审 P3-C4 ③）
    expect(tryBody.match(/\} finally \{/g)?.length, "tryChatAutoReconnect 体内 finally 的个数").toBe(1);
    // 末尾三层：`if` 的 `}`、finally 的 `}`、函数体自己的 `}`
    expect(tryBody).toMatch(
      /\} finally \{\s*if \(getReconnectStops\(\)\.get\(task\.id\) === reconnectStop\) \{\s*getReconnectStops\(\)\.delete\(task\.id\);\s*\}\s*\}\s*\}$/,
    );
  });

  // rollbackForeignContentMidRun 的「shared 且 run 在跑才让位」成立的前提：沿用者登记（置 shared）的那一刻，它自己的 run 已经算「在跑」，
  // 不会出现「登记了、run 还没起、登记者的回滚恰好落在中间 → 误清」的缝（第十一轮评审 P3-1 / P3-6「沿用者走 runChatSession / resume 路径」）。
  // 读剥掉注释的源码做顺序断言——只能防回退，行为靠上面的运行时用例。resume 路径靠 claimRun（resumeChatSession 注册会话记录那一刻就置 runActive = true），
  // 随后的首发走 sendChatMessage，同一条不变式——读码核对、这里没有断言、也没有 resume 路径的真链路用例（第十一轮评审 P3-6 点名的缺口，未补）。
  it("沿用者登记时它的 run 已经在跑：sendChatMessage 的 runActive = true 紧贴入口（之间无 await）且早于 begin（之间无 await）；runChatSession 的占位记录 runActive: true 早于它的 begin", () => {
    const src = readSource("src/lib/server/chat-runner.ts");
    const entry = src.indexOf("export const sendChatMessage = async (");
    expect(entry).toBeGreaterThan(-1);
    const active = src.indexOf("rec.runActive = true;", entry);
    const begin = src.indexOf("foreignToken = beginForeignContentMidRun(task.id)", entry);
    expect(active).toBeGreaterThan(entry);
    expect(begin).toBeGreaterThan(active);
    expect(src.slice(entry, active)).not.toMatch(/\bawait\b/);
    expect(src.slice(active, begin)).not.toMatch(/\bawait\b/);
    const run = src.indexOf("export const runChatSession = async (");
    expect(run).toBeGreaterThan(-1);
    // 占位记录：`myRec` 的字面量里 `runActive: true`，随后 `runningChats.set(task.id, myRec)` 注册进表，首包前的 begin 在这之后。
    // 此前只比「`runActive: true,` 与 begin 的物理位置」（该字面量可以是别处的对象）；现在钉的是同一条语句序列：字面量 → 注册 → begin，
    // 且注册到 begin 之间不得把 runActive 放掉 / 把记录摘出表（第十六轮评审 P3-C4 ③；仍是读剥掉注释的源码，只能防回退）
    const recAt = src.indexOf("const myRec: RunningChatRecord = {", run);
    const setAt = src.indexOf("runningChats.set(task.id, myRec);", run);
    const begin2 = src.indexOf("if (foreignContentTurn === true) beginForeignContentMidRun(task.id);", run);
    expect(recAt, "找得到占位记录的字面量").toBeGreaterThan(run);
    expect(setAt, "占位记录注册进 runningChats").toBeGreaterThan(recAt);
    expect(src.slice(recAt, setAt), "占位记录一出生就是 runActive: true").toMatch(/\brunActive:\s*true,/);
    expect(begin2, "首包前的 begin 在占位注册之后").toBeGreaterThan(setAt);
    expect(src.slice(setAt, begin2), "占位注册到 begin 之间把 runActive 放掉 / 把记录摘出表：沿用者登记那一刻 run 不再算在跑").not.toMatch(
      /runActive\s*=\s*false|runningChats\.delete\(/,
    );
  });
});

describe("中途补登（beginForeignContentMidRun / endMidRunForeignContent）", () => {
  it("没有标记 → 新建 scope=desktop 的 midRun 标记并返回 token；系统工具硬拒（scope=all）不受影响", () => {
    const token = guard.beginForeignContentMidRun("t1");
    expect(typeof token).toBe("string");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("已有活标记 → 不新建、不降级、不覆盖，返回 undefined（原标记收口归它自己的登记者）", () => {
    const all = guard.beginNonOwnerTurn("t1", Date.now(), "all");
    expect(guard.beginForeignContentMidRun("t1")).toBeUndefined();
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true); // 仍是 all，没被降成 desktop
    guard.endMidRunForeignContent("t1"); // 它不是 midRun：这一下不能清掉它
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    guard.endNonOwnerTurn("t1", all);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("endMidRunForeignContent 只清 midRun 的；send 起点登记的标记（有自己的 token）它不碰", () => {
    const sendMarker = guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    guard.endMidRunForeignContent("t1");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    guard.endNonOwnerTurn("t1", sendMarker);

    guard.beginForeignContentMidRun("t2");
    guard.endMidRunForeignContent("t2");
    expect(guard.isGroupNonOwnerTurnActive("t2")).toBe(false);
    // 没标记时 no-op、不抛
    expect(() => guard.endMidRunForeignContent("nope")).not.toThrow();
  });

  // 第十七轮评审 N5：这条只钉**原语** `endNonOwnerTurn` 的按 token 收口语义，不是哪条生产回滚的现行写法——
  // chat / ask 侧的送达失败回滚早已是让位版 `rollbackForeignContentMidRun`（第十五轮 P3-3 F1、第十六轮 P3-D1），下面「rollbackForeignContentMidRun」那组才是它们的用例。
  it("原语 endNonOwnerTurn 按 token 收口（不是生产回滚路径）；被紧随其后的 send 起点标记取代后，旧 token 收口是 no-op", () => {
    const rolledBack = guard.beginForeignContentMidRun("t1");
    guard.endNonOwnerTurn("t1", rolledBack);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);

    const mid = guard.beginForeignContentMidRun("t1");
    const send = guard.beginNonOwnerTurn("t1", Date.now(), "desktop"); // deliverAskReply 的 send 起点登记
    guard.endNonOwnerTurn("t1", mid); // 旧 token：no-op
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    guard.endMidRunForeignContent("t1"); // send 起点的不是 midRun：不清
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    guard.endNonOwnerTurn("t1", send);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  // 第十轮评审 N1：登记者（ask-inject）要跨过长 await（等 ask-wait 的 curl，最长 15 秒）才送达，窗口里别路的外来内容沿用了它的标记——
  // 沿用者没有自己的 token、那一轮只靠这个标记；登记者的回滚不能把它一起清掉
  it("rollbackForeignContentMidRun：没人沿用 → 按 token 清（与 endNonOwnerTurn 一样）", () => {
    const token = guard.beginForeignContentMidRun("t1");
    guard.rollbackForeignContentMidRun("t1", token);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("rollbackForeignContentMidRun：登记之后被别路沿用过（beginForeignContentMidRun 返回 undefined）、且此刻还有 run 在跑 → 不清；沿用者那一轮收尾按名清后才没", () => {
    const token = guard.beginForeignContentMidRun("t1");
    expect(guard.beginForeignContentMidRun("t1")).toBeUndefined(); // 别路沿用
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, (id) => id === "t1"); // 沿用者送达了：它那一轮在跑
    guard.rollbackForeignContentMidRun("t1", token);
    expect(guard.isGroupNonOwnerTurnActive("t1"), "登记者回滚把沿用者正靠着的标记清了").toBe(true);
    guard.rollbackForeignContentMidRun("t1", token); // 重复回滚也不清
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    guard.endMidRunForeignContent("t1");
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  // 第十一轮评审 P3-1：让位的前提是「沿用者那一轮在跑、会为标记收尾」。沿用者没送达（send 抛错 / 没有会话）时没有 run 在跑——
  // 注意这是**靠存活探针推断**的（探针答错就会错判，第十二轮评审 P2-1 就是 chat 探针在重连空窗里答错一例），不是自明的事实——
  // 这个标记没有主人了：chat 没有「属主 send 起点清」，不清就只剩惰性 TTL，属主下一整轮的 desktop_* / 写所有者备注 / 新建定时都被多限制到那一轮结束。
  it("rollbackForeignContentMidRun：被沿用过、但此刻没有 run 在跑（沿用者没送达）→ 照清，不留没人收尾的孤儿", () => {
    const token = guard.beginForeignContentMidRun("t1");
    expect(guard.beginForeignContentMidRun("t1")).toBeUndefined(); // 沿用者：没有自己的 token
    // 沿用者没送达：没有任何 run 在跑（真实的 task 探针 = runningTasks 里没有 t1；chat 探针没有会话）
    guard.rollbackForeignContentMidRun("t1", token);
    expect(guard.isGroupNonOwnerTurnActive("t1"), "沿用者没送达、没有 run 在跑，标记成了孤儿").toBe(false);
  });

  it("rollbackForeignContentMidRun：「有没有 run 在跑」只看这个 task——别的 task 在跑不让这一个让位", () => {
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, (id) => id === "other");
    const token = guard.beginForeignContentMidRun("t1");
    guard.beginForeignContentMidRun("t1"); // 沿用
    guard.rollbackForeignContentMidRun("t1", token);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("rollbackForeignContentMidRun：探针抛错按「在跑」算（fail-closed）→ 让位，不是误清", () => {
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => {
      throw new Error("probe broke");
    });
    const token = guard.beginForeignContentMidRun("t1");
    guard.beginForeignContentMidRun("t1"); // 沿用
    expect(() => guard.rollbackForeignContentMidRun("t1", token)).not.toThrow();
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
  });

  it("rollbackForeignContentMidRun：真实的 task 探针（runningTasks）——沿用者的 run 在表里就让位，出表后同一个 token 再回滚就清了", () => {
    const token = guard.beginForeignContentMidRun("t-prod");
    guard.beginForeignContentMidRun("t-prod"); // 沿用
    runningTasks.set("t-prod", { instanceId: 1 } as never);
    guard.rollbackForeignContentMidRun("t-prod", token);
    expect(guard.isGroupNonOwnerTurnActive("t-prod")).toBe(true);
    runningTasks.delete("t-prod");
    guard.rollbackForeignContentMidRun("t-prod", token);
    expect(guard.isGroupNonOwnerTurnActive("t-prod")).toBe(false);
  });

  // 第十一轮评审 P3-6：被沿用的标记走同一套 TTL / 续命，不因为 shared 就永生或提前过期
  it("被沿用（shared）的标记：run 在跑过 TTL 照样续命；run 没了过 TTL 惰性清掉，之后登记者的回滚是 no-op、不抛", () => {
    vi.useFakeTimers();
    at("10:00");
    let alive = true;
    guard.__setNonOwnerRunProbeForTest(TEST_PROBE, (id) => id === "t1" && alive);
    const token = guard.beginForeignContentMidRun("t1", Date.now());
    guard.beginForeignContentMidRun("t1", Date.now()); // 沿用
    at("10:50"); // 过了 45 分钟 TTL，但沿用者的 run 还在跑 → 续命
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    alive = false;
    at("11:40"); // 距上次续命又过了 50 分钟、run 没了 → 惰性过期
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
    expect(() => guard.rollbackForeignContentMidRun("t1", token)).not.toThrow();
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("rollbackForeignContentMidRun：沿用的标志只跟着那一个标记走——标记清掉再新登记的，不继承", () => {
    const first = guard.beginForeignContentMidRun("t1");
    guard.beginForeignContentMidRun("t1"); // 沿用
    guard.endMidRunForeignContent("t1"); // 沿用者那一轮收尾
    const second = guard.beginForeignContentMidRun("t1");
    expect(second).toBeDefined();
    guard.rollbackForeignContentMidRun("t1", first); // 旧 token：no-op
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(true);
    guard.rollbackForeignContentMidRun("t1", second); // 新标记没被沿用过：照常清
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("rollbackForeignContentMidRun：没有 token（自己沿用了别人的）/ token 已被后继覆盖 / 没标记 → no-op，不误清、不抛", () => {
    const all = guard.beginNonOwnerTurn("t1", Date.now(), "all");
    expect(guard.beginForeignContentMidRun("t1")).toBeUndefined();
    guard.rollbackForeignContentMidRun("t1", undefined);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    guard.rollbackForeignContentMidRun("t1", "no-such-token");
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    guard.endNonOwnerTurn("t1", all);

    const mid = guard.beginForeignContentMidRun("t2");
    guard.beginNonOwnerTurn("t2", Date.now(), "desktop"); // 被 send 起点标记取代
    guard.rollbackForeignContentMidRun("t2", mid);
    expect(guard.isGroupNonOwnerTurnActive("t2")).toBe(true);
    expect(() => guard.rollbackForeignContentMidRun("nope", "x")).not.toThrow();
  });

  describe("isLiveMarkerToken（第十五轮评审 P3-3 F1）：只读，问「这个 token 登记出来的标记此刻还是不是活着的那一个」", () => {
    it("活着的 → true；被清 / 被别的标记覆盖 / 没有 token → false（旧 token 不会因为同 task 新登记了标记而变真）", () => {
      const token = guard.beginForeignContentMidRun("t1")!;
      expect(token).toBeTruthy();
      expect(guard.isLiveMarkerToken("t1", token)).toBe(true);
      expect(guard.isLiveMarkerToken("t1", undefined), "没有 token 恒为 false").toBe(false);
      expect(guard.isLiveMarkerToken("t1", ""), "空串 token 恒为 false").toBe(false);
      expect(guard.isLiveMarkerToken(undefined, token), "没有 taskId 恒为 false").toBe(false);
      expect(guard.isLiveMarkerToken("t2", token), "别的 task 的标记不算").toBe(false);

      guard.endMidRunForeignContent("t1");
      expect(guard.isLiveMarkerToken("t1", token), "被清之后").toBe(false);

      const first = guard.beginForeignContentMidRun("t1")!;
      const second = guard.beginNonOwnerTurn("t1", Date.now(), "desktop"); // 被 send 起点标记覆盖
      expect(guard.isLiveMarkerToken("t1", first), "被覆盖之后旧 token 不再算").toBe(false);
      expect(guard.isLiveMarkerToken("t1", second)).toBe(true);
    });

    it("过期且 run 不在的标记视为不在（与 isGroupNonOwnerTurnActive 同一把尺子）；run 还活着就续命、仍算在", () => {
      vi.useFakeTimers();
      at("10:00");
      let alive = false;
      guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => alive);
      const token = guard.beginForeignContentMidRun("t1")!;
      at("10:50"); // 过了 45 分钟 TTL、run 不在
      expect(guard.isLiveMarkerToken("t1", token)).toBe(false);

      at("11:00");
      alive = true;
      const again = guard.beginForeignContentMidRun("t1")!;
      at("11:50"); // 又过了 TTL，但 run 还活着 → 续命
      expect(guard.isLiveMarkerToken("t1", again)).toBe(true);
    });

    it("纯读：问过不会把标记置成「被沿用」——此后 run 在跑时的回滚照清（对照：真有人再登记一次，回滚就让位）", () => {
      guard.__setNonOwnerRunProbeForTest(TEST_PROBE, () => true);
      const mine = guard.beginForeignContentMidRun("t1")!;
      expect(guard.isLiveMarkerToken("t1", mine)).toBe(true);
      expect(guard.isLiveMarkerToken("t1", mine)).toBe(true);
      guard.rollbackForeignContentMidRun("t1", mine);
      expect(guard.isGroupNonOwnerTurnActive("t1"), "只是问过，没人沿用：回滚应照清").toBe(false);

      const other = guard.beginForeignContentMidRun("t2")!;
      expect(guard.beginForeignContentMidRun("t2"), "再登记一次 = 沿用").toBeUndefined();
      guard.rollbackForeignContentMidRun("t2", other);
      expect(guard.isGroupNonOwnerTurnActive("t2"), "被沿用 + run 在跑：让位").toBe(true);
    });
  });

  // 【第十六轮评审 P3-D1 订正】这段注释和下面的标题原先把「登记者已占住投递位的回滚（sendChatMessage / chat-inject 直送与新会话路径）仍按 token 硬清」写成现状，
  // 第十五轮评审 P3-3 F1 之后不成立了：chat 侧的回滚（`sendChatMessage` 的三个失主出口 / chat-inject 的外层 finally、入队、`already_running`，以及第十六轮 C2 补的 `already_settled`）全部改成了让位版
  // `rollbackForeignContentMidRun`，`src/` 里 chat 侧对 `endNonOwnerTurn` / `clearNonOwnerTurn` 零调用；`endNonOwnerTurn` 现在只剩 task 型 send 起点标记的收口
  // （consumeSessionRun / sendToTaskSessionBody / internalStartAgent / 一次性问答的 finally——都是「调用方确知没有沿用者」的按 token 收口）。
  // 同样地，「自己沿用自己」不再是 chat-inject 新会话路径的常态：`registerForeignMark` 在自己的 token 还活着时不二次登记（isLiveMarkerToken，见上面那一组），
  // 仍有的自沿用只剩 runChatSession 内层那次 begin（紧贴 agent.send、token 已交出之后，丢弃 token、靠 finally 按名清）。
  // 下面这条只钉**原语本身**的语义：endNonOwnerTurn 是按 token 的硬清、不看 shared——不再声称它是 chat 侧哪条回滚的现行写法。
  // 分界的判据仍见 beginForeignContentMidRun 的注释（第十一轮评审 P3-3 更正过「没有长 await」，第十二轮评审 P3-4 统一成「登记者有没有占住投递位」）
  it("endNonOwnerTurn（原语）不受「被沿用」影响：按 token 硬清、不看 shared——给「调用方确知没有沿用者」的收口用（task 型 send 起点标记的 finally）；chat 侧的回滚已全部改让位版", () => {
    const token = guard.beginForeignContentMidRun("t1");
    expect(guard.beginForeignContentMidRun("t1")).toBeUndefined(); // runner 内部沿用调用方预登记的
    guard.endNonOwnerTurn("t1", token);
    expect(guard.isGroupNonOwnerTurnActive("t1")).toBe(false);
  });

  it("源码钉：chat 侧与 midRun 回滚方（chat-runner / chat-inject / ask-inject / task-question-inject）不出现 endNonOwnerTurn / clearNonOwnerTurn 调用——回滚一律走让位版（旧注释写反过，后人可能照着改回硬清；第十六轮评审 P3-D1）", () => {
    for (const rel of [
      "src/lib/server/chat-runner.ts",
      "src/lib/server/chat-inject.ts",
      "src/lib/server/feishu-bridge/ask-inject.ts",
      "src/lib/server/task-question-inject.ts",
    ]) {
      const src = readSource(rel);
      expect(src.match(/\b(endNonOwnerTurn|clearNonOwnerTurn)\(/g), `${rel} 里出现了按 token / 按 task 的硬清调用`).toBeNull();
    }
  });

  it("midRun 标记经咽喉生效：电脑操作 / 恒拒清单被拒，普通系统工具放行；run 收尾后全部恢复", async () => {
    guard.beginForeignContentMidRun("t1");
    const sw = mkTool("submit_work");
    expect(textOf(await call(sw.tool, { task_id: "t1" }, "t1"))).toBe("HANDLED:submit_work");

    const shot = mkTool("desktop_screenshot");
    expect(textOf(await call(shot.tool, {}, "t1"))).toBe(DESKTOP_NON_OWNER_DENIED);
    const note = mkTool("set_owner_note");
    expect(textOf(await call(note.tool, {}, "t1"))).toContain("[DENIED]");
    expect(shot.handler).not.toHaveBeenCalled();
    expect(note.handler).not.toHaveBeenCalled();

    guard.endMidRunForeignContent("t1");
    expect(textOf(await call(shot.tool, {}, "t1"))).toBe("HANDLED:desktop_screenshot");
    expect(textOf(await call(note.tool, {}, "t1"))).toBe("HANDLED:set_owner_note");
  });
});
