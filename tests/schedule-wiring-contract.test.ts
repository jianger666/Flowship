/**
 * 定时任务：接线契约（源码级）。
 *
 * node 环境渲染不了 React、也起不来整条 inject / 归档 / 删除链，这些「挂在别人身上的钩子」只能钉源码：
 * 谁被改没了，定时就会悄悄失效（该取消的没取消、该有的入口没了、到点的消息变成顶掉提问的普通消息……）。
 * 行为本身在 tests/schedule*.test.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { toolBlockSummary, type ToolBlock } from "@/lib/tool-display";

const src = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("到点消息走普通用户消息的路径，但不抢用户的东西（scheduledTrigger）", () => {
  it("chat-inject：定时触发不认领「隐式跳过待答提问」（用惰性句柄）", () => {
    const s = src("src/lib/server/chat-inject.ts");
    expect(s).toMatch(/options\.scheduledTrigger\s*\?\s*INERT_ASK_SKIP\s*:\s*beginAskSkip\(task\)/);
  });

  it("task-question-inject：定时触发不 snapshot 产物 / 不认领跳过 / 不唤醒阶段", () => {
    const s = src("src/lib/server/task-question-inject.ts");
    expect(s).toMatch(/const ackAction =\s*questionOnly \|\| options\.scheduledTrigger\s*\?\s*undefined/);
    expect(s).toMatch(
      /const askSkip =\s*questionOnly \|\| options\.correlatedAnswer \|\| options\.scheduledTrigger\s*\?\s*null/,
    );
    expect(s).toMatch(/const canResume =\s*!questionOnly &&\s*!options\.scheduledTrigger &&/);
  });

  it("task-question-inject：scheduledTrigger 一路传到两个最终封装文本的地方（有会话 send / 一次性 agent），脚注才不会掉回「用户的插话」", () => {
    const s = src("src/lib/server/task-question-inject.ts");
    // deliverTaskQuestion(... , timing, options.scheduledTrigger === true)
    expect(s).toMatch(/\btiming,\s*options\.scheduledTrigger === true,\s*\),/);
    // startOneShotQuestion(... , opGen, options.scheduledTrigger === true)
    expect(s).toMatch(/\bopGen,\s*options\.scheduledTrigger === true,\s*\);/);
    const runner = src("src/lib/server/task-runner.ts");
    // 两处 user_message 封装都带 scheduled
    const userMessageCalls = runner.match(/buildAgentMessage\(\{\s*kind: "user_message",[\s\S]*?\}\)/g) ?? [];
    expect(userMessageCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of userMessageCalls) expect(c).toContain("scheduled");
  });

  it("ask-skip 的惰性句柄是个空操作句柄（不是第二套真实现）", () => {
    expect(src("src/lib/server/ask-skip.ts")).toMatch(
      /export const INERT_ASK_SKIP: AskSkipHandle = NOOP_HANDLE;/,
    );
  });

  it("schedule-service 两条投递路径都带 scheduledTrigger:true + userReplyMetaExtra（UI 靠 meta.source 渲染）", () => {
    const s = src("src/lib/server/schedule-service.ts");
    expect(s.match(/^\s+scheduledTrigger: true,$/gm)).toHaveLength(2);
    expect(s.match(/userReplyMetaExtra: req\.meta/g)).toHaveLength(2);
    expect(s).toContain("handleChatReplyInject");
    expect(s).toContain("handleTaskQuestionInject");
  });
});

describe("会话生命周期：归档 / 删除 → 定时一起取消", () => {
  const runner = src("src/lib/server/task-runner.ts");
  const fnStart = runner.indexOf("export const archiveTaskWithCleanup = async (");

  it("归档：在 chat / 非 worktree 的早退之前取消（否则 chat 归档了定时还在、会悄悄唤醒归档的会话）", () => {
    expect(fnStart).toBeGreaterThan(0);
    const body = runner.slice(fnStart, fnStart + 6000);
    const cancelAt = body.indexOf('cancelSchedulesWithNotice(taskId, "会话已归档", "archived"');
    const earlyReturnAt = body.indexOf('if (task.mode === "chat" || !isWorktreeTask(task))');
    expect(cancelAt).toBeGreaterThan(0);
    expect(earlyReturnAt).toBeGreaterThan(cancelAt);
  });

  it("取消归档（archived=false）不碰定时：取消过的不会因为恢复归档又回来", () => {
    const body = runner.slice(fnStart, fnStart + 1500);
    const falseBranch = body.slice(
      body.indexOf("if (!archived) {"),
      body.indexOf("const task = await getTaskMeta(taskId);"),
    );
    expect(falseBranch).toContain("setTaskPinArchive(taskId, { archived: false })");
    expect(falseBranch).not.toContain("Schedule");
  });

  it("取消失败只 log、不挡归档 / 终结主流程（共用 cancelSchedulesWithNotice）", () => {
    const helperAt = runner.indexOf("const cancelSchedulesWithNotice = async (");
    expect(helperAt).toBeGreaterThan(0);
    const body = runner.slice(helperAt, helperAt + 1500);
    expect(body).toMatch(/try \{\s*const cancelled = await cancelAllSchedulesForTask[\s\S]*?\} catch \(err\) \{\s*console\.warn\(/);
  });

  it("任务终结（合入 / 放弃）：取消定时——否则周期定时在终结之后继续触发", () => {
    const at = runner.indexOf("export const finalizeTask = async (");
    expect(at).toBeGreaterThan(0);
    const body = runner.slice(at, at + 4000);
    const revoke = body.indexOf("revokeTaskOps(taskId);");
    const cancel = body.indexOf("cancelSchedulesWithNotice(");
    const cancelRun = body.indexOf("cancelTaskRun(taskId);");
    expect(revoke).toBeGreaterThan(0);
    // 在停 agent / 清 worktree / 改 repoStatus 这些动作之前取消，不给到点投递留空窗
    expect(cancel).toBeGreaterThan(revoke);
    expect(cancel).toBeLessThan(cancelRun);
    expect(body.slice(cancel, cancel + 400)).toContain('"cancelled"');
  });

  it("删除会话：把任务从调度索引摘掉（紧跟子代理记录的同类清理）", () => {
    const s = src("src/app/api/tasks/[id]/route.ts");
    const a = s.indexOf("forgetSubagentRunsForDeletedTask(id);");
    const b = s.indexOf("forgetSchedulesForDeletedTask(id);");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});

describe("启动锚点与进程内状态", () => {
  it("飞书桥接 bootstrap 动态 import 调度器（静态 import 会把 @cursor/sdk 拖进 webpack bundle）", () => {
    const s = src("src/lib/server/feishu-bridge/bootstrap.ts");
    expect(s).toMatch(/void import\("\.\.\/schedule-service"\)\s*\.then\(\(m\) => m\.ensureScheduleRunnerStarted\(\)\)/);
    expect(s).not.toMatch(/^import[^\n]*schedule-service/m);
  });

  it("调度器启动放在 bootstrap 的 finally：飞书桥接任一步抛错也不能让定时跟着起不来；vitest 下不起", () => {
    const s = src("src/lib/server/feishu-bridge/bootstrap.ts");
    const fn = s.slice(s.indexOf("export const ensureFeishuBridgeBootstrapped"));
    expect(fn).toMatch(/\}\s*finally\s*\{\s*startScheduleRunner\(\);\s*\}/);
    // 在 finally 之前、桥接自己的 VITEST 早退不能把调度器启动一起短路掉（return 会走 finally，但启动函数自己也要守 VITEST）
    const starter = s.slice(s.indexOf("const startScheduleRunner"), s.indexOf("export const ensureFeishuBridgeBootstrapped"));
    expect(starter).toContain("if (process.env.VITEST) return;");
    expect(starter).toContain("ensureScheduleRunnerStarted");
  });

  it("三个 schedules API 在模块加载时就起调度器（用户先打开管理页也能起来）", () => {
    for (const rel of [
      "src/app/api/schedules/route.ts",
      "src/app/api/tasks/[id]/schedules/route.ts",
      "src/app/api/tasks/[id]/schedules/[sid]/route.ts",
    ]) {
      expect(src(rel), rel).toMatch(/^ensureScheduleRunnerStarted\(\);$/m);
    }
  });

  it("vitest / next build 阶段不起定时器；timer unref、不拖住进程退出", () => {
    const s = src("src/lib/server/schedule-service.ts");
    expect(s).toContain("if (process.env.VITEST) return;");
    expect(s).toContain('process.env.NEXT_PHASE === "phase-production-build"');
    expect(s).toContain("timer.unref?.()");
  });

  it("共享状态都放 globalThis（Next dev 下 route 是不同 chunk，模块级变量会各持一份 → 双发）", () => {
    expect(src("src/lib/server/schedule-store.ts")).toContain("__flowshipScheduleLiveIndexV1__");
    expect(src("src/lib/server/schedule-runner.ts")).toContain("__flowshipScheduleRunnerStateV1__");
    const svc = src("src/lib/server/schedule-service.ts");
    expect(svc).toContain("__flowshipScheduleRunnerV1__");
    expect(svc).toContain("__flowshipScheduleTimerStartedV1__");
  });

  it("调度器启动时一并订阅「排队的定时消息被清掉」（queue_failed）；只在真启动路径上，且在 tick 之前", () => {
    const svc = src("src/lib/server/schedule-service.ts");
    expect(svc).toContain('import { startScheduleQueueLossWatcher } from "./schedule-queue-loss"');
    const fn = svc.slice(svc.indexOf("export const ensureScheduleRunnerStarted"));
    const watcher = fn.indexOf("startScheduleQueueLossWatcher();");
    // 在 VITEST / next build 的早退之后（那两种场景不该订阅全局流）、在第一次 tick 之前
    expect(watcher).toBeGreaterThan(fn.indexOf("if (g[STARTED_KEY]) return;"));
    expect(watcher).toBeLessThan(fn.indexOf("runner.tick()"));
    const mod = src("src/lib/server/schedule-queue-loss.ts");
    expect(mod).toContain('ev.kind !== "queue_failed"');
    expect(mod).toContain("subscribeAllTaskStreams");
    // 订阅放 globalThis、重复启动先摘旧的（dev HMR）
    expect(mod).toContain("__flowshipScheduleQueueLossUnsubV1__");
    expect(mod).toContain("g[UNSUB_KEY]?.();");
  });

  it("工具文件不 import schedule-service（它拖着 chat-inject，会形成循环依赖）", () => {
    expect(src("src/lib/server/flowship-tools.ts")).not.toMatch(/from "\.\/schedule-service"/);
  });
});

describe("UI 接线（review 🟡 修复）", () => {
  it("ScheduleActions：busy 撑到列表刷新回来（await onChanged）；取消 / 删除记录两步确认；刷新失败不算操作失败", () => {
    const s = src("src/components/schedules/schedule-actions.tsx");
    expect(s).toContain("onChanged: () => void | Promise<void>;");
    // 刷新（await onChanged）在 finally 清 busy 之前
    const run = s.slice(s.indexOf("const run = async"), s.indexOf("return (\n    <span"));
    expect(run.indexOf("await onChanged()")).toBeGreaterThan(0);
    expect(run.indexOf("await onChanged()")).toBeLessThan(run.indexOf("setBusy(null)"));
    expect(run).not.toMatch(/\n\s+onChanged\(\);/); // 不再有不 await 的 onChanged()
    // 两步确认：destructive 且没上膛 → 只上膛、不发请求
    expect(run).toMatch(/if \(spec\.destructive && armed !== spec\.action\) \{\s*setArmed\(spec\.action\);\s*return;/);
    expect(run.indexOf("setArmed(spec.action)")).toBeLessThan(run.indexOf("runScheduleAction("));
    expect(s).toContain("`确认${spec.label}`");
    expect(s).toContain("CONFIRM_WINDOW_MS");
    // 上膛前后是同一个 Tooltip + Button 元素（只换 props / 内容）：焦点不丢、不靠 autoFocus，Popover 里也不会被当成 focus-out
    const render = s.slice(s.indexOf("return (\n    <span"));
    expect(render.match(/<Button\b/g)).toHaveLength(1);
    expect(render.match(/<Tooltip\b/g)).toHaveLength(1);
    expect(render).not.toContain("autoFocus");
    expect(render).toContain("onBlur={isArmed ? () => setArmed(null) : undefined}");
    expect(render).toContain('size={isArmed ? "sm" : "icon-sm"}');
    // 立即触发 / 暂停 / 恢复不是破坏性操作、不用确认
    expect(s).toMatch(/fire: \{[^}]*\}/);
    expect(s).not.toMatch(/fire: \{[^}]*destructive/);
    expect(s).not.toMatch(/pause: \{[^}]*destructive/);
    // 父组件都把「返回 Promise 的刷新」交下来
    expect(src("src/app/schedules/page.tsx")).toContain("onChanged={() => load()}");
    expect(src("src/components/tasks/schedule-chip.tsx")).toContain("onChanged={reload}");
  });

  it("管理页：load 有请求序号守卫（旧响应不盖新的）；首次加载失败显示错误 + 重试而不是「还没有定时」；所属会话是真链接", () => {
    const s = src("src/app/schedules/page.tsx");
    expect(s).toContain("const seq = ++loadSeqRef.current;");
    expect(s.match(/if \(seq !== loadSeqRef\.current\) return;/g)).toHaveLength(2);
    expect(s).toContain("if (seq === loadSeqRef.current) setLoading(false);");
    // 15 秒轮询 / 操作后的静默刷新不转圈（否则刷新按钮周期性闪烁 + 短暂禁用）；只有手动刷新 / 重试才置 loading
    expect(s).toContain("if (opts?.manual) setLoading(true);");
    expect(s.match(/setLoading\(true\)/g)).toHaveLength(1);
    expect(s).toContain("window.setInterval(() => void load(), POLL_MS)");
    expect(s.match(/load\(\{ manual: true \}\)/g)).toHaveLength(2); // 刷新 + 重试两个按钮
    expect(s).toContain("const [loadError, setLoadError]");
    // 首次加载失败：不再 setItems([]) 伪装成空
    expect(s).not.toContain("setItems((prev) => prev ?? [])");
    expect(s).toContain("加载定时任务失败：{loadError}");
    expect(s).toContain("重试");
    // 轮询失败：保留上次数据并提示
    expect(s).toContain("显示的是上次的数据");
    expect(s).toContain("scheduleEmptyMessage(filter, counts)");
    expect(s).toContain("<Link");
    expect(s).toContain("href={`/tasks/${r.taskId}`}");
    expect(s).not.toContain("router.push(`/tasks/");
  });

  it("ScheduleChip：外层只算 signal、内层 memo；useNow 只在有定时时起定时器", () => {
    const s = src("src/components/tasks/schedule-chip.tsx");
    expect(s).toContain("const ScheduleChipInner = memo(function ScheduleChipInner(");
    expect(s).toContain("const now = useNow(schedules.length > 0);");
    expect(s).toContain("if (!active) return;");
    expect(s).toContain("<ScheduleChipInner taskId={taskId} signal={signal} inset={inset} />");
  });

  it("定时触发的 user_reply：气泡与粘顶头用同一份展示文本；最后一条是它时不给「重新生成」（否则样板 / 备忘被当成用户的话重发）", () => {
    const rows = src("src/components/tasks/event-stream/rows.tsx");
    expect(rows).toContain("userReplyDisplayText(ev)");
    expect(rows).toContain("isScheduleUserReply(ev)");
    expect(rows).not.toContain("cleanGroupQuestionText"); // 去噪逻辑只在 userReplyDisplayText 里一份
    const stream = src("src/components/tasks/event-stream.tsx");
    expect(stream).toContain("const canRegenerateFromLastUserReply = !!lastUserReply && !isScheduleUserReply(lastUserReply);");
    expect(stream).toMatch(/!isRunning &&\s*canRegenerateFromLastUserReply &&\s*item\.id === lastAssistantId/);
    // 处理函数自己也守一道（别的入口调进来也不重发）
    expect(stream).toContain("if (!lastUserReply || isScheduleUserReply(lastUserReply)) return;");
    // 粘顶头走 resolveStickyTurn → userReplyDisplayText
    expect(src("src/lib/chat-stream-display.ts")).toContain("text: userReplyDisplayText(it)");
  });

  it("事件流：定时触发的用户消息渲染成「定时触发 · 标题」徽标 + 当时留的话；不给重发 / 编辑，回退仍可用", () => {
    const s = src("src/components/tasks/event-stream/rows.tsx");
    expect(s).toContain("const isScheduleMsg = isScheduleUserReply(ev);");
    expect(s).toContain("ev.meta.scheduleTitle");
    expect(s).toContain("定时触发 · ${scheduleTitle}");
    expect(s).toMatch(/onResend &&\s*!isScheduleMsg && \{/);
    expect(s).toMatch(/editHandler &&\s*!isScheduleMsg && \{/);
    expect(s).toMatch(/canRewind && \{/);
  });

  it("会话内定时条：chat 挂在事件流输入岛上方，task 挂在「跟 AI 说」输入条上方（两处都有、各一处）", () => {
    const es = src("src/components/tasks/event-stream.tsx");
    expect(es.match(/<ScheduleChip /g)).toHaveLength(1);
    expect(es).toContain("<ScheduleChip taskId={task.id} events={task.events} />");
    const page = src("src/app/tasks/[id]/page.tsx");
    expect(page.match(/<ScheduleChip /g)).toHaveLength(1);
    expect(page).toContain("<ScheduleChip taskId={task.id} events={task.events} inset />");
    // task 的条必须在输入条前面
    expect(page.indexOf("<ScheduleChip")).toBeLessThan(page.indexOf("<TaskTalkComposer"));
  });

  it("管理页入口：顶栏有「定时任务」按钮 → /schedules；/schedules 是中性页 + 独立布局", () => {
    const header = src("src/components/app-header.tsx");
    expect(header).toContain('href="/schedules"');
    expect(header).toContain("定时任务");
    expect(header).toMatch(/pathname\.startsWith\("\/schedules"\)/);
    expect(src("src/components/app-shell.tsx")).toMatch(/pathname\.startsWith\("\/schedules"\)/);
  });

  it("管理页提供全部操作：立即触发 / 暂停 / 恢复 / 取消 / 清理（按状态给，不手写一份）", () => {
    const actions = src("src/components/schedules/schedule-actions.tsx");
    expect(actions).toContain("availableScheduleActions");
    for (const a of ["fire", "pause", "resume", "cancel", "remove"]) {
      expect(actions, a).toContain(a);
    }
  });

  it("每条定时的 API 只接受五种动作；会话没了 / 找不到是 404，状态不对是 409", () => {
    const s = src("src/app/api/tasks/[id]/schedules/[sid]/route.ts");
    for (const a of ["cancel", "pause", "resume", "fire", "remove"]) {
      expect(s, a).toContain(`"${a}"`);
    }
    expect(s).toMatch(/not_found[\s\S]{0,80}task_gone|task_gone[\s\S]{0,80}not_found/);
    expect(s).toContain("404");
    expect(s).toContain("409");
  });
});

describe("工具块摘要：schedule", () => {
  const block = (args: string | undefined) =>
    ({
      kind: "__tool_block__",
      id: "b1",
      callId: "s1",
      name: "schedule",
      status: "completed",
      text: "调用 schedule",
      args,
    }) as unknown as ToolBlock;

  it("有入参 → 一行摘要；读不出来回落通用逻辑，不抛不空白", () => {
    expect(toolBlockSummary(block('{"action":"create","title":"看 CI","delay_minutes":30}'))).toBe(
      "创建 · 30 分钟后 · 看 CI",
    );
    expect(toolBlockSummary(block("garbage"))).toBe("garbage");
    expect(toolBlockSummary(block(undefined))).toBe("调用 schedule");
  });
});
