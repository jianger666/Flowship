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

import {
  OUTLINE_EDGE_INSET_PX,
  OUTLINE_PANEL_GAP_PX,
  OUTLINE_PANEL_WIDTH_PX,
  outlinePanelRightShift,
  pickOutlinePanelSide,
} from "@/lib/stream-outline";

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
  it("时间线只在事件流视图渲染（!showQaPanel），带稳定 props；chat 贴内容列、task 贴最左缘", () => {
    expect(code).toMatch(
      /\{!showQaPanel && \(\s*<StreamOutlineRail\s+items=\{railItems\}\s+activeStore=\{outlineActiveStore\}\s+onJump=\{onOutlineJump\}\s+jumpingId=\{jumpingId\}\s+anchor=\{isChat \? "column" : "edge"\}\s*\/>\s*\)\}/,
    );
  });

  it("chat 把手的 48rem 与事件流里 chat 内容列的 max-w-3xl 同宽（改一处必须改另一处，否则把手会悬在离正文很远的地方）", () => {
    // 事件流：chat 内容列 = 居中 + max-w-3xl（48rem）+ px-6（正文从列左缘 + 24px 起）
    expect(code).toContain('isChat && "mx-auto w-full max-w-3xl px-6"');
    const rail = stripComments(read("components", "tasks", "stream-outline-rail.tsx"));
    // 48rem = max-w-3xl；8px = Virtuoso 的 scrollbar-gutter；6px = 往列左缘外挪的量（把手 ≤ 14px 宽 → 离正文还剩 16px）
    expect(rail).toContain('const COLUMN_ANCHOR_LEFT = "max(2px, calc((100% - 8px - 48rem) / 2 - 6px))"');
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

  it("可发现性：折叠态有图标把手；刻度 3px 粗、非当前刻度不再是看不见的 bg-border", () => {
    // 用户反馈「都不知道左边有个这个」：老版本是 2px × 6px 的 bg-border 细线（对白底约 1.2:1）、没有任何控件标识
    expect(src).toContain("<ListTree");
    expect(src).toContain('"h-[3px] rounded-full ');
    expect(src).not.toMatch(/\bbg-border\b/);
  });

  it("非当前刻度的对比度：alpha ≥ 70（浅色页面底 3.28:1）——可点控件的图形要过 WCAG 1.4.11 的 3:1，/60 只有 2.68:1", () => {
    // 从源码里解析 alpha（不透明 = 100 也算过）：谁改回 /60 或更淡就红。
    // 算法：--muted-foreground oklch(0.46 0.01 264) 按 alpha 叠在 --background oklch(0.967 0.002 247) 上，WCAG 相对亮度——
    // 浅色 /50 2.21、/60 2.68、/70 3.28、/80 4.07、不透明 6.48；深色 /60 就有 3.40。
    // 刻度是控件图形、不是文字：「文字不叠 alpha / 4.5:1」（ui-conventions）不适用，适用的是非文本对比度 3:1
    const m = /"w-2 bg-muted-foreground(?:\/(\d+))? /.exec(src);
    expect(m, "非当前刻度的写法变了：同步改这里的解析").not.toBeNull();
    const alpha = m![1] === undefined ? 100 : Number(m![1]);
    expect(alpha).toBeGreaterThanOrEqual(70);
  });

  it("anchor：默认 edge 贴最左缘（left-0.5）；column 走内联 left（COLUMN_ANCHOR_LEFT）", () => {
    expect(src).toContain('anchor = "edge"');
    expect(src).toContain('anchor === "edge" && "left-0.5"');
    expect(src).toContain('style={anchor === "column" ? { left: COLUMN_ANCHOR_LEFT } : undefined}');
  });

  it("展开面板朝向：展开那一刻（layout effect，绘制前）量把手左侧空间，放得下向左开、放不下向右开并拉回最左缘", () => {
    expect(src).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!open\) return;\s*const root = rootRef\.current;\s*if \(!root\) return;\s*const roomLeft = root\.offsetLeft;\s*setPanelSide\(pickOutlinePanelSide\(roomLeft\)\);\s*setPanelShiftPx\(outlinePanelRightShift\(roomLeft\)\);\s*\}, \[open\]\)/,
    );
    expect(src).toContain('panelSide === "left" && "right-full mr-1"');
    // 面板宽 w-72（288px）/ 缝 mr-1（4px）与纯函数里的常量同值：量的空间要和实际占的空间对得上
    expect(src).toMatch(/\bw-72\b/);
    const lib = stripComments(read("lib", "stream-outline.ts"));
    expect(lib).toContain("export const OUTLINE_PANEL_WIDTH_PX = 288;");
    expect(lib).toContain("export const OUTLINE_PANEL_GAP_PX = 4;");
    // 向右开：面板左缘走 inline style（值 = outlinePanelRightShift，≤ 0）、不再写死 left-0 跟着把手左缘走；
    // 落点常量（2px）与 task 形态把手的 left-0.5（0.125rem）= 旧版面板的位置同值
    expect(src).toContain('style={panelSide === "right" ? { left: panelShiftPx } : undefined}');
    // 面板开头标签（id → style）里不许再写 left-0：会让向右开的面板重新跟着把手左缘走（窄窗口固定多盖正文 258px）
    const panelStart = src.indexOf("id={panelId}");
    const panelStyle = src.indexOf('style={panelSide === "right"');
    expect(panelStart).toBeGreaterThan(-1);
    expect(panelStyle).toBeGreaterThan(panelStart);
    expect(src.slice(panelStart, panelStyle)).not.toMatch(/(?<![\w-])left-0(?![\w.])/);
    expect(src).toContain('anchor === "edge" && "left-0.5"');
    expect(lib).toContain("export const OUTLINE_EDGE_INSET_PX = 2;");
    expect(OUTLINE_EDGE_INSET_PX).toBe(0.125 * 16);
  });

  it("几何：chat 把手（14px 宽）在任何窗口宽度下都不压正文——与正文（内容列左缘 + 24px）至少留 8px", () => {
    // 从源码的公式字符串里解析各个量，而不是在测试里另写一份：谁改了偏移量，这里按数值重算，压到正文就红
    const m =
      /COLUMN_ANCHOR_LEFT = "max\((\d+)px, calc\(\(100% - (\d+)px - (\d+)rem\) \/ 2 - (\d+)px\)\)"/.exec(src);
    expect(m, "COLUMN_ANCHOR_LEFT 的写法变了：同步改这里的解析").not.toBeNull();
    const [minLeft, gutter, columnRem, shift] = m!.slice(1, 5).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const column = columnRem * 16; // 内容列宽（max-w-3xl = 48rem）
    const railWidth = 14; // 刻度 span 的 w-3.5（图标 size-3 = 12px 更窄）
    expect(src).toContain("h-2.5 w-3.5");
    const textInset = 24; // chat 内容列的 px-6：正文从列左缘 + 24px 才开始
    for (let w = 320; w <= 3200; w += 8) {
      const colLeft = Math.max(0, (w - gutter - column) / 2); // 内容列左缘（窗口窄到顶满时贴 0）
      const left = Math.max(minLeft, (w - gutter - column) / 2 - shift); // calc 里的 100% 就是事件区宽 w
      const gap = colLeft + textInset - (left + railWidth); // 把手右缘 → 正文左缘
      expect(gap, `事件区宽 ${w}px`).toBeGreaterThanOrEqual(8);
    }
  });

  it("几何：窄窗口向右开的面板对正文的覆盖量与旧版（面板钉在最左缘）逐档相等；向左开的一点不盖、也不跑出事件区", () => {
    // 背景（R12 评审抓到）：把手搬到内容列旁边后，向右开的面板若还与把手左缘对齐，会固定盖住正文 258px，
    // 而旧版（把手和面板都在最左缘）只盖 max(0, 266 - 内容列左缘)——事件区 1000px 时多盖 104px、1300px 时多盖 254px。
    // 与上一条同样从源码公式里解析把手位置（谁改了偏移量，这里按数值重算），再用真实的纯函数算面板落点
    const m =
      /COLUMN_ANCHOR_LEFT = "max\((\d+)px, calc\(\(100% - (\d+)px - (\d+)rem\) \/ 2 - (\d+)px\)\)"/.exec(src);
    expect(m, "COLUMN_ANCHOR_LEFT 的写法变了：同步改这里的解析").not.toBeNull();
    const [minLeft, gutter, columnRem, shift] = m!.slice(1, 5).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const column = columnRem * 16;
    const textInset = 24; // chat 内容列的 px-6：正文从列左缘 + 24px 才开始
    // 面板区间 [panelLeft, panelRight] 与正文区间 [textLeft, +∞) 的交叠宽度
    const overlap = (panelLeft: number, panelRight: number, textLeft: number): number =>
      Math.max(0, panelRight - Math.max(panelLeft, textLeft));
    // 旧版：把手贴最左缘（left-0.5），面板左缘与把手对齐 → [2, 2 + 288]
    const legacyRight = OUTLINE_EDGE_INSET_PX + OUTLINE_PANEL_WIDTH_PX;
    const opened = { left: 0, right: 0 };
    for (let w = 320; w <= 3200; w += 8) {
      const railLeft = Math.max(minLeft, (w - gutter - column) / 2 - shift); // = 展开时量到的 root.offsetLeft
      const textLeft = Math.max(0, (w - gutter - column) / 2) + textInset;
      if (pickOutlinePanelSide(railLeft) === "left") {
        opened.left += 1;
        const panelRight = railLeft - OUTLINE_PANEL_GAP_PX;
        const panelLeft = panelRight - OUTLINE_PANEL_WIDTH_PX;
        expect(overlap(panelLeft, panelRight, textLeft), `事件区宽 ${w}px 向左开`).toBe(0);
        expect(panelLeft, `事件区宽 ${w}px 向左开的面板左缘（不能跑出事件区）`).toBeGreaterThanOrEqual(0);
      } else {
        opened.right += 1;
        const panelLeft = railLeft + outlinePanelRightShift(railLeft);
        expect(panelLeft, `事件区宽 ${w}px 向右开的面板左缘`).toBe(OUTLINE_EDGE_INSET_PX);
        expect(overlap(panelLeft, panelLeft + OUTLINE_PANEL_WIDTH_PX, textLeft), `事件区宽 ${w}px 向右开`).toBe(
          overlap(OUTLINE_EDGE_INSET_PX, legacyRight, textLeft),
        );
      }
    }
    // 两个分支都真的走到过：别因为公式变了、循环里一边永远不进而空转
    expect(opened.left).toBeGreaterThan(0);
    expect(opened.right).toBeGreaterThan(0);
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
