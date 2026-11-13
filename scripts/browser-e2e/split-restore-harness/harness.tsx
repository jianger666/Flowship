import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  ARTIFACT_PANEL_MAX_PERCENT,
  EVENT_STREAM_MIN_PX,
  isArtifactCollapsedSize,
  planSplitToggle,
  resolveArtifactDefaultPercent,
} from "@/lib/task-split-layout";
import {
  applyTaskSplitRestore,
  collapsedPaneFromLayout,
  readTaskSplit,
  TASK_SPLIT_KEY,
  writeTaskSplit,
  type CollapsedPane,
} from "@/lib/task-split-memory";
import { createUserResizeIntent, shouldRecordResizePointerDown } from "@/lib/user-resize-intent";

/**
 * 任务页分栏「收起态记忆」的 e2e harness（由 r17-task-split-restore.cjs 打包后放进真 Electron 窗口，用真库、真鼠标验证）。
 *
 * 照着 src/app/tasks/[id]/page.tsx 的结构摆：真的 ResizablePanelGroup / ResizablePanel / ResizableHandle（同样的 id / collapsible /
 * collapsedSize / minSize / maxSize / defaultSize 写法）、同样「主区宽度量到之后才挂 Group」的 ref 回调、同样的 useLayoutEffect 恢复
 * （任务已加载 + 宽度已量到 + 两个句柄都在、每个任务一次）、同样的 onResize 回写 state、同样的 onLayoutChanged + 用户意图闸写记忆、
 * 同样的头部按钮（planSplitToggle）与「放大」（折叠事件流）。记忆读写 / 判定 / 恢复函数是**真的**（src/lib/task-split-memory）；
 * 页面里的 effect 本身不是被测对象（page.tsx 太大没法进 harness），它的接线由 tests/task-split-memory.test.ts 的源码契约守着。
 *
 * URL 参数：w（容器像素宽）、memo=artifact|event-stream（先写入记忆，模拟「上次收起后离开」）、keep=1（不清 localStorage，
 * 用于「同一份记忆下重新挂载」= 切走再切回）。每次加载默认先清 localStorage，免得上一个窗口写的记忆串进来。
 */
const q = new URLSearchParams(location.search);
const W = Number(q.get("w") ?? 1400);
const w = window as unknown as Record<string, unknown>;
const TASK = "t1";

if (!q.get("keep")) localStorage.clear();
if (q.get("memo")) writeTaskSplit(TASK, q.get("memo") as CollapsedPane);

const Harness = () => {
  const [mainWidth, setMainWidth] = useState<number | null>(null);
  const mainWidthRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setMainWidth(el.clientWidth);
  }, []);
  const artifactPanelRef = usePanelRef();
  const eventStreamPanelRef = usePanelRef();
  const [artifactCollapsed, setArtifactCollapsed] = useState(false);
  const [eventStreamCollapsed, setEventStreamCollapsed] = useState(false);
  const [browserTab, setBrowserTab] = useState(false);
  const intentRef = useRef(createUserResizeIntent());
  const restoredFor = useRef<string | null>(null);
  const layoutLog = useRef<unknown[]>([]);

  const artifactDefaultPercent = resolveArtifactDefaultPercent({ persisted: null, containerWidth: mainWidth });

  // —— 同 page.tsx 的恢复 effect ——
  useLayoutEffect(() => {
    if (mainWidth == null) return;
    if (restoredFor.current === TASK) return;
    const artifact = artifactPanelRef.current;
    const eventStream = eventStreamPanelRef.current;
    if (!artifact || !eventStream) return;
    restoredFor.current = TASK;
    const pane = readTaskSplit(TASK);
    if (!pane) return;
    w.__restoreResult = applyTaskSplitRestore(pane, { artifact, eventStream });
  }, [mainWidth, artifactPanelRef, eventStreamPanelRef]);

  useEffect(() => {
    const end = () => intentRef.current.pointerUp(Date.now());
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  // —— 同 page.tsx 的 toggleSplitLayout / toggleBrowserMaximize（用户动作里写记忆） ——
  const toggleSplit = () => {
    const artifact = artifactPanelRef.current;
    const eventStream = eventStreamPanelRef.current;
    const action = planSplitToggle({
      artifactCollapsed: artifact?.isCollapsed() ?? false,
      eventStreamCollapsed: eventStream?.isCollapsed() ?? false,
    });
    if (action === "expand-event-stream") {
      eventStream?.expand();
      if (eventStream) writeTaskSplit(TASK, null);
    } else if (action === "expand-artifact") {
      artifact?.expand();
      if (artifact) writeTaskSplit(TASK, null);
    } else {
      artifact?.collapse();
      if (artifact) writeTaskSplit(TASK, "artifact");
    }
    return action;
  };
  const toggleMaximize = () => {
    const eventStream = eventStreamPanelRef.current;
    if (!eventStream) return;
    if (eventStream.isCollapsed()) {
      eventStream.expand();
      writeTaskSplit(TASK, null);
    } else {
      eventStream.collapse();
      writeTaskSplit(TASK, "event-stream");
    }
  };
  w.__h = {
    toggleSplit,
    toggleMaximize,
    setBrowserTab: (v: boolean) => setBrowserTab(v),
    state: () => ({ artifactCollapsed, eventStreamCollapsed, layoutLog: layoutLog.current }),
    memo: () => readTaskSplit(TASK),
    rawMemo: () => localStorage.getItem(TASK_SPLIT_KEY),
  };

  return (
    <div
      id="box"
      style={{ width: W, height: 500, display: "flex" }}
      ref={mainWidthRef}
      onPointerDownCapture={(e) => {
        if (shouldRecordResizePointerDown(e)) intentRef.current.pointerDown();
      }}
    >
      {mainWidth == null ? null : (
        <ResizablePanelGroup
          id={`task-layout-${TASK}`}
          orientation="horizontal"
          onLayoutChanged={(layout) => {
            layoutLog.current.push({ ...layout });
            const pane = collapsedPaneFromLayout(layout);
            if (pane !== "unknown" && intentRef.current.isActive(Date.now())) {
              writeTaskSplit(TASK, pane === "none" ? null : pane);
            }
          }}
        >
          <ResizablePanel
            id="artifact"
            panelRef={artifactPanelRef}
            defaultSize={`${artifactDefaultPercent}%`}
            minSize={browserTab ? "300px" : "20%"}
            maxSize={`${ARTIFACT_PANEL_MAX_PERCENT}%`}
            collapsible
            collapsedSize={0}
            onResize={(size) => setArtifactCollapsed(isArtifactCollapsedSize(size.asPercentage))}
          >
            <div style={{ height: "100%" }}>artifact</div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="event-stream"
            panelRef={eventStreamPanelRef}
            defaultSize={`${100 - artifactDefaultPercent}%`}
            minSize={`${EVENT_STREAM_MIN_PX}px`}
            collapsible
            collapsedSize={0}
            onResize={(size) => setEventStreamCollapsed(isArtifactCollapsedSize(size.asPercentage))}
          >
            <div style={{ height: "100%", minWidth: EVENT_STREAM_MIN_PX }}>event</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
};

createRoot(document.getElementById("root")!).render(<Harness />);
