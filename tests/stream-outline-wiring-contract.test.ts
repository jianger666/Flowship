/**
 * 提问时间线接线的源码契约闸。
 *
 * React 在 node 环境跑不起来（见 vitest.config.ts），组件 / hook 的行为没法直接测；这里钉的是
 * 「那些一改回去就静默出事、又不会让任何行为测试变红」的接线：
 *   1. 当前轮只通过外部 store 更新（rangeChanged 里不 setState 父组件 / 不 scrollToIndex）；
 *   2. 跳转只走 jumpToItem 这一个 scrollToIndex 出口；跳到窗口之外靠复用 loadEarlier 的 until 模式分页，
 *      不另起「整窗替换」（评审 RC2：窗口整体换掉会让 Virtuoso 视口锚定失效）；
 *   3. 拉取期间不提前停跟随（失败 / 封顶时不用恢复，不会把用户从底部拽走）；
 *   4. 窗口已含全部历史时不发大纲请求；回退后重拉；失败只 warn 不打扰用户；
 *   5. 时间线只在事件流视图渲染（群问答 tab 是另一份只读列表）；
 *   6. 路由走和 events 同一套可见性闸（commitReadableTaskResponse / taskVisibilityErrorResponse）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...p: string[]): string => readFileSync(path.join(srcDir, ...p), "utf-8");

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 从 `marker` 起、到它后面第一个 `=>` 之后的第一个 `{` 起，按花括号配对截出完整函数体（签名里的类型字面量 `{}` 不算） */
const sliceBlock = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的花括号没配平`);
};

const eventStreamSrc = read("components", "tasks", "event-stream.tsx");
const code = stripComments(eventStreamSrc);

describe("event-stream 接线：当前轮", () => {
  it("rangeChanged 把当前轮写进外部 store；块里不 setState、不 scrollToIndex", () => {
    const block = sliceBlock(code, "rangeChanged={(range) =>");
    expect(block).toContain("outlineActiveStore.set(resolveActiveOutlineId(list, localIdx))");
    expect(block).not.toMatch(/\bset[A-Z]\w*\(/);
    expect(block).not.toContain("scrollToIndex");
  });

  it("外部 store 在 EventStream 里只建一次（useMemo）", () => {
    expect(code).toMatch(/const outlineActiveStore = useMemo\(\(\) => createActiveOutlineStore\(\), \[\]\)/);
  });
});

describe("event-stream 接线：点击跳转", () => {
  const jump = sliceBlock(code, "const jumpToOutlineItem = async (eventId: string) =>");

  it("已渲染 → jumpToItem(idx, 'start', 'auto')：不自己调 scrollToIndex / 不直接停跟随", () => {
    expect(jump).toContain('jumpToItem(idx, "start", "auto")');
    expect(jump).not.toContain("scrollToIndex");
    // 拉取期间不提前停跟随：失败 / 封顶 / 摘掉死项时就没有要恢复的状态
    expect(jump).not.toContain("setFollowing");
  });

  it("窗口之外 → 复用 loadEarlier 的 until 模式（封顶 OUTLINE_JUMP_MAX_EVENTS），不另起整窗替换", () => {
    expect(jump).toMatch(
      /await loadEarlier\(\{\s*eventId,\s*maxEvents: OUTLINE_JUMP_MAX_EVENTS,/,
    );
    // 整窗替换的入口（resync / replaceTaskEventsWithSnapshot）一个都不能出现在时间线跳转里
    expect(jump).not.toMatch(/resync|replaceTaskEventsWithSnapshot|setTask\(|onReplaceEvents/);
  });

  it("按结果分流：拉到 → 等渲染后跳；封顶 → 提示再点一次；读完没有 → 摘掉死项 + 提示", () => {
    expect(jump).toContain("res.found");
    expect(jump).toContain("settleOutlineJump(eventId)");
    expect(jump).toContain("res.capped");
    expect(jump).toContain("再点一次继续往前");
    expect(jump).toContain("res.exhausted");
    expect(jump).toContain("markOutlineItemGone(eventId)");
  });

  it("切任务后迟到的结果丢弃（与 loadEarlier 同一套 taskIdRef 比对）", () => {
    expect(jump).toMatch(/taskIdRef\.current !== requestedTaskId\) return/);
  });

  it("可取消：加载期间用户自己滚了 / 对话被回退 / 切任务 → 下一批前停手，拉到之后也不跳（不把人从他刚滚到的地方拽走）", () => {
    expect(jump).toMatch(/jumpCancelledRef\.current = false;\s*setJumpingId\(eventId\)/);
    expect(jump).toContain("isAborted: () => jumpCancelledRef.current");
    // 取消检查在 await 之后、任何「跳 / 提示」之前
    const afterAwait = jump.slice(jump.indexOf("await loadEarlier("));
    expect(afterAwait.indexOf("if (jumpCancelledRef.current) return;")).toBeGreaterThan(0);
    expect(afterAwait.indexOf("if (jumpCancelledRef.current) return;")).toBeLessThan(
      afterAwait.indexOf("settleOutlineJump(eventId)"),
    );
    // 取消旗：切任务 / lastRewind 推进时置位
    expect(code).toMatch(
      /useEffect\(\(\) => \{\s*jumpCancelledRef\.current = true;\s*\}, \[task\.id, task\.lastRewind\?\.ts\]\)/,
    );
    // 用户输入（滚轮 / 触摸 / 键盘）在跳转进行期间置位，且清理干净
    const listen = sliceBlock(code, "useEffect(() => {\n    if (!jumpingId) return;");
    for (const t of ["wheel", "touchstart", "keydown"]) {
      expect(listen).toContain(`addEventListener("${t}", cancel`);
      expect(listen).toContain(`removeEventListener("${t}", cancel)`);
    }
  });

  it("拉到之后等它渲染进 Virtuoso 再跳：rAF 里重新算下标、算不到就等 items 再变；有超时兜底", () => {
    const effect = sliceBlock(code, "useEffect(() => {\n    if (!pendingJumpRef.current) return;");
    expect(effect).toContain("requestAnimationFrame");
    expect(effect).toContain("findRenderIndexForEventId(itemsRef.current, id)");
    expect(effect).toContain('jumpToItem(idx, "start", "auto")');
    expect(effect).toContain("cancelAnimationFrame(raf)");
    // 依赖：items 变了（prepend 渲染进来）/ jumpTick（刚登记目标）/ jumpToItem
    expect(code).toMatch(/cancelAnimationFrame\(raf\);\s*\}, \[items, jumpTick, jumpToItem\]\)/);
    expect(code).toContain("OUTLINE_JUMP_SETTLE_TIMEOUT_MS");
  });

  it("scrollToIndex 仍然只有 jumpToItem 一个「跳到某项」出口（另一处是兜底贴底的 LAST）——时间线没有新增", () => {
    const all = code.match(/\.scrollToIndex\(\{/g) ?? [];
    const last = code.match(/\.scrollToIndex\(\{[^}]*"LAST"/g) ?? [];
    expect(last).toHaveLength(1);
    expect(all.length - last.length).toBe(1);
    expect(sliceBlock(code, "const jumpToItem = useCallback(")).toContain("scrollToIndex");
  });

  it("T-2：新的点击先作废上一次「拉到了、等渲染」的目标（函数第一件事）", () => {
    const body = jump.slice(jump.indexOf("{") + 1);
    expect(body.trimStart().startsWith("//")).toBe(false); // 注释已被 stripComments 剥掉，剩下的第一条语句就是它
    expect(body.trimStart()).toMatch(/^pendingJumpRef\.current = null;/);
  });

  it("T-3：主动回到最新（点「回到最新」/ Cmd+End / 提交即到底）作废进行中的跳转：三个入口都经 cancelOutlineJump", () => {
    const cancel = sliceBlock(code, "const cancelOutlineJump = useCallback(() =>");
    expect(cancel).toContain("jumpCancelledRef.current = true");
    expect(cancel).toContain("pendingJumpRef.current = null");
    // 「回到最新」按钮与 Cmd+End 共用 backToBottom
    const back = sliceBlock(code, "const backToBottom = useCallback(() =>");
    expect(back.indexOf("cancelOutlineJump()")).toBeGreaterThanOrEqual(0);
    expect(back.indexOf("cancelOutlineJump()")).toBeLessThan(back.indexOf("follow.scrollToBottomSmooth()"));
    expect(code).toMatch(/onBackToBottom=\{backToBottom\}/);
    expect(code).toMatch(/if \(!isModCombo\(e, "End"\)\) return;[\s\S]{0,400}backToBottom\(\);/);
    // 提交即到底
    const scanAt = code.indexOf("applyPendingScan(");
    const scan = code.slice(scanAt, code.indexOf("[pendingLocalReplies", scanAt));
    expect(scan.indexOf("cancelOutlineJump()")).toBeGreaterThanOrEqual(0);
    expect(scan.indexOf("cancelOutlineJump()")).toBeLessThan(scan.indexOf("follow.scrollToBottomSmooth()"));
  });

  it("T-6：卸载（离开页面）也作废进行中的跳转——cleanup 就是 cancelOutlineJump；每次发起跳转复位旗标，所以 StrictMode 的模拟卸载无害", () => {
    expect(code).toMatch(/useEffect\(\(\) => cancelOutlineJump, \[cancelOutlineJump\]\);/);
    // cleanup 只应在卸载时触发：cancelOutlineJump 必须是空依赖的 useCallback，否则依赖一变就会误取消进行中的跳转
    expect(code).toMatch(/const cancelOutlineJump = useCallback\(\(\) => \{[^}]*\}, \[\]\);/);
    // 复位在发起跳转处（await 之前），模拟卸载留下的 true 不会让真正的跳转被吞
    const jump = sliceBlock(code, "const jumpToOutlineItem = async (eventId: string) =>");
    expect(jump.indexOf("jumpCancelledRef.current = false")).toBeGreaterThan(0);
    expect(jump.indexOf("jumpCancelledRef.current = false")).toBeLessThan(jump.indexOf("await loadEarlier("));
  });

  it("T-1：往前加载超过一会儿弹常驻的「正在往前找这条消息…」提示，结束（成功 / 失败 / 取消）一律在 finally 里收掉", () => {
    expect(jump).toMatch(/window\.setTimeout\(\(\) => \{\s*loadingToastId = toast\.loading\("正在往前找这条消息…"\);\s*\}, OUTLINE_JUMP_LOADING_TOAST_DELAY_MS\)/);
    const fin = jump.slice(jump.lastIndexOf("finally"));
    expect(fin).toContain("window.clearTimeout(loadingToastTimer)");
    expect(fin).toContain("toast.dismiss(loadingToastId)");
  });

  it("给 memo 化的时间线传稳定回调（ref 转发），不是每次渲染都新的闭包", () => {
    expect(code).toMatch(/jumpToOutlineItemRef\.current = jumpToOutlineItem/);
    expect(code).toMatch(/const onOutlineJump = useCallback\(\(eventId: string\) => \{\s*void jumpToOutlineItemRef\.current\(eventId\);\s*\}, \[\]\)/);
  });
});

describe("event-stream 接线：loadEarlier 的 until 模式", () => {
  const load = sliceBlock(code, "const loadEarlier = async (");

  it("带 until 时把目标事件 id 与大页传给 fetchEarlierBatch，不带时行为不变", () => {
    expect(load).toMatch(/untilEventId: until\.eventId, pageSize: OUTLINE_JUMP_PAGE_SIZE/);
    expect(load).toMatch(/\.\.\.\(until\s*\?/);
  });

  it("until 模式：找到 / 读完 / 封顶才收工，否则提交后接着拉；普通模式仍是 progressed || !hasMore", () => {
    expect(load).toContain("batch.found");
    expect(load).toContain("loadedEvents >= until.maxEvents");
    expect(load).toMatch(/if \(batch\.progressed \|\| !batch\.hasMore\) break/);
  });

  it("until 模式每批开拉之前问 isAborted，被取消就停在已拉到的位置", () => {
    expect(load).toMatch(/if \(until\?\.isAborted\?\.\(\)\) \{\s*result\.aborted = true;\s*break;\s*\}/);
    expect(load.indexOf("until?.isAborted?.()")).toBeLessThan(load.indexOf("await fetchEarlierBatch("));
  });

  it("仍然走同一套 prepend + firstItemIndex 同步递减", () => {
    expect(load).toContain("onPrependEvents(fresh)");
    expect(load).toMatch(/setFirstItemIndex\(\(fi\) => fi - \(afterLen - beforeLen\)\)/);
  });
});

describe("event-stream 接线：渲染", () => {
  it("时间线只在事件流视图渲染（!showQaPanel），带稳定 props", () => {
    expect(code).toMatch(
      /\{!showQaPanel && \(\s*<StreamOutlineRail\s+items=\{railItems\}\s+activeStore=\{outlineActiveStore\}\s+onJump=\{onOutlineJump\}\s+jumpingId=\{jumpingId\}\s*\/>\s*\)\}/,
    );
  });

  it("时间线渲染在与 Virtuoso 同一个 relative 容器里（absolute 定位靠它）、且在 Virtuoso 之前", () => {
    const rail = code.indexOf("<StreamOutlineRail");
    const virtuoso = code.indexOf("<Virtuoso", rail);
    expect(rail).toBeGreaterThan(0);
    expect(virtuoso).toBeGreaterThan(rail);
  });

  it("切 task 重置跳转 / 死项 / 当前轮", () => {
    expect(code).toMatch(
      /pendingJumpRef\.current = null;\s*setJumpingId\(null\);\s*setDeadOutlineIds\(new Set\(\)\);\s*outlineActiveStore\.set\(null\);\s*\}, \[task\.id, outlineActiveStore\]\)/,
    );
  });
});

describe("useTaskOutline", () => {
  const src = stripComments(read("hooks", "use-task-outline.ts"));

  it("窗口已含全部历史（truncated=false）时不发大纲请求", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!truncated\) return;/);
  });

  it("回退（lastRewind.ts 变）后重拉；取失败只 console.warn、不 toast", () => {
    expect(src).toMatch(/\[taskId, truncated, rewindTs\]/);
    expect(src).toContain("console.warn");
    expect(src).not.toContain("toast");
  });

  it("取失败带退避重试（瞬时网络错误不该让长会话的时间线一直只剩窗口内的项），耗尽才 warn", () => {
    expect(src).toMatch(
      /fetchWithBackoff\(\(\) => fetchTaskOutline\(taskId, ac\.signal\), OUTLINE_RETRY_DELAYS_MS, \{\s*signal: ac\.signal,/,
    );
    expect(src).toMatch(/OUTLINE_RETRY_DELAYS_MS: readonly number\[\] = \[1500, 6000\]/);
  });

  it("T-5：404 / 410（任务已删 / 不存在）直接放弃、不白等重试；其余照常重试", () => {
    expect(src).toMatch(
      /shouldRetry: \(err\) =>\s*!\(err instanceof ApiRequestError && \(err\.status === 404 \|\| err\.status === 410\)\)/,
    );
  });

  it("请求可取消（切任务 / 回退重拉时作废上一次）、迟到的响应丢弃", () => {
    expect(src).toContain("new AbortController()");
    expect(src).toContain("return () => ac.abort()");
    expect(src).toMatch(/if \(ac\.signal\.aborted\) return/);
  });

  it("别的任务的大纲不串进来；合并结果走 stabilizeOutline 保引用稳定", () => {
    expect(src).toMatch(/server\.taskId === taskId/);
    expect(src).toContain("stabilizeOutline(stableRef.current, merged)");
    expect(src).toContain("mergeOutline(serverItems, events, rewindFrom)");
  });
});

describe("时间线组件", () => {
  const src = stripComments(read("components", "tasks", "stream-outline-rail.tsx"));

  it("当前轮走 useSyncExternalStore 订阅外部 store（滚动不重渲事件流）", () => {
    expect(src).toContain("useSyncExternalStore(activeStore.subscribe, activeStore.get, noActive)");
  });

  it("memo 包裹；不足 2 个可见项整条不画", () => {
    expect(src).toMatch(/export const StreamOutlineRail = memo\(/);
    expect(src).toContain("if (visible.length < MIN_VISIBLE_ITEMS) return null");
  });

  it("定时触发默认不显示、偏好持久化走 view-memory", () => {
    expect(src).toContain("loadOutlineShowSchedule()");
    expect(src).toContain("saveOutlineShowSchedule(next)");
    expect(src).toContain("visibleOutline(items, showSchedule)");
  });

  it("T-1：折叠态对 jumpingId 有反馈——按钮 aria-busy、目标刻度脉冲（减少动态效果时靠加长变深）", () => {
    expect(src).toContain("aria-busy={jumpingId ? true : undefined}");
    expect(src).toMatch(/isJumpTarget\s*\?\s*"[^"]*animate-pulse[^"]*motion-reduce:animate-none[^"]*"/);
    expect(src).toMatch(/isJumpTarget\s*\?\s*"w-3 /);
    expect(src).toMatch(/jumpingIndex >= t\.first && jumpingIndex <= t\.last/);
  });

  it("跳转进行中不叠加新的跳转（jumpingId 闸）", () => {
    expect(src).toMatch(/if \(jumpingId\) return;/);
  });

  it("展开定位当前轮用手算 scrollTop，不用会连带滚外层的 scrollIntoView", () => {
    expect(src).not.toContain("scrollIntoView");
    expect(src).toContain("list.scrollTop =");
  });
});

describe("不变量：事件窗口被整体替换只发生在回退路径（时间线只在挂载 / 切任务 / 回退时取服务端大纲）", () => {
  const lines = (f: string[]): string => stripComments(read(...f));

  it("replaceTaskEventsWithSnapshot 的调用点只有两处：task-store 的回退对齐、页面 resyncEvents；别处新增必须同时给 useTaskOutline 加重拉信号", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(ent.name)) {
          const n = (stripComments(readFileSync(full, "utf-8")).match(/replaceTaskEventsWithSnapshot\(/g) ?? []).length;
          for (let i = 0; i < n; i++) callers.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(callers.sort()).toEqual(["app/tasks/[id]/page.tsx", "lib/task-store.ts"]);
    // task-store 里那一处是回退对齐分支
    expect(lines(["lib", "task-store.ts"])).toMatch(
      /if \(rewind\.resync\) return replaceTaskEventsWithSnapshot\(prev, next\)/,
    );
  });

  it("页面的 resyncEvents 只有回退触发的三个入口（lastRewindNeedsResync / SSE 回退标记 / 合并结果的 resync）", () => {
    const page = lines(["app", "tasks", "[id]", "page.tsx"]);
    expect(page).toMatch(/lastRewindNeedsResync\(cur, next\)\) \{[\s\S]{0,260}resyncEventsRef\.current\?\.\(\)/);
    expect(page).toContain("if (cur && rewindNeedsResync(cur, ev)) void resyncEvents();");
    expect(page).toContain("if (resync) void resyncEvents();");
    expect((page.match(/void resyncEvents\(\)/g) ?? []).length).toBe(2);
    expect((page.match(/resyncEventsRef\.current\?\.\(\)/g) ?? []).length).toBe(1);
  });
});

describe("服务端", () => {
  it("路由走与 events 同一套可见性闸", () => {
    const route = stripComments(read("app", "api", "tasks", "[id]", "outline", "route.ts"));
    expect(route).toContain('export const runtime = "nodejs"');
    expect(route).toContain("getTaskEventsOutline(id)");
    expect(route).toContain("taskVisibilityErrorResponse(id)");
    expect(route).toContain("commitReadableTaskResponse(id, () => outline)");
  });

  it("getTaskEventsOutline：先过可读闸 → 读 meta → 扫盘 → 扫完复查可读", () => {
    const fs = stripComments(read("lib", "server", "task-fs.ts"));
    const block = sliceBlock(fs, "export const getTaskEventsOutline = async (");
    const order = [
      "ensureBootRecovery()",
      "assertTaskReadable(id)",
      "readMetaRaw(id)",
      "readEventsOutline(id)",
      'failpoint("getTaskEventsOutline.afterRead")',
    ].map((s) => block.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 扫完之后还有一次 assertTaskReadable
    expect(block.lastIndexOf("assertTaskReadable(id)")).toBeGreaterThan(block.indexOf("readEventsOutline(id)"));
  });

  it("扫盘只读：不 import 任何写入口（追加链 / 写 meta / 回退）", () => {
    const src = stripComments(read("lib", "server", "events-outline.ts"));
    expect(src).not.toMatch(/appendEventLine|withEventAppendChain|writeMeta|withTaskLock|atomicWriteTextFile|writeFile/);
  });
});
