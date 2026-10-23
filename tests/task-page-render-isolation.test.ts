/**
 * V11-07（第二轮 review，与第一轮 U2-01 同条）：产物栏每次**页面**渲染都把整篇产物 markdown 重渲一遍。
 *
 * 根因链：
 *  1. `useSmoothStreaming()` 在页面组件里（rAF 驱动的 setState）→ AI 一边吐字，整个 task 页按帧重渲；
 *  2. `onArtifactRefClick`（内联箭头函数）/ `repoShortNames`（每次新数组）进了 ArtifactPanel 里
 *     components useMemo 的依赖，Streamdown 的 Block 比较器逐键比 components → 每帧整篇重渲；
 *  3. `ArtifactPanel` 没 memo。
 *
 * 修法（见各断言）：① 平滑 state 下沉到只订阅它的 SmoothEventStream，页面不再持有逐帧 state；
 * ② 回调 / 数组 / 批次表稳定化；③ memo(ArtifactPanel)。
 *
 * 取舍：这些都只能靠源码契约钉住接线，渲染耗时没有用 Profiler 实测过（需要真机）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const page = stripComments(read("src/app/tasks/[id]/page.tsx"));
const host = stripComments(read("src/components/tasks/smooth-event-stream.tsx"));
const panel = stripComments(read("src/components/tasks/artifact-panel.tsx"));
const hook = read("src/components/tasks/use-smooth-streaming.ts");

describe("① 平滑吐字 state 下沉：页面不再持有逐帧 state", () => {
  it("页面不再调用 useSmoothStreaming / 不再 import 它", () => {
    expect(page).not.toMatch(/\buseSmoothStreaming\b/);
    expect(page).not.toContain("use-smooth-streaming");
  });

  it("页面 EventStream 的位置换成 SmoothEventStream，并且不再向它传 streamingText", () => {
    expect(page).toContain("<SmoothEventStream");
    expect(page).not.toMatch(/<EventStream\b/);
    expect(page).not.toMatch(/streamingText=/);
  });

  it("页面里的 pushDelta / clearStreaming 是稳定转发（空依赖 useCallback → controlsRef），原有调用点不用改", () => {
    expect(page).toMatch(
      /const pushDelta = useCallback\(\(text: string\) => \{\s*streamControlsRef\.current\?\.pushDelta\(text\);\s*\}, \[\]\);/,
    );
    expect(page).toMatch(
      /const clearStreaming = useCallback\(\(\) => \{\s*streamControlsRef\.current\?\.clearStreaming\(\);\s*\}, \[\]\);/,
    );
    // 进行中正文快照同样走稳定转发（空依赖），SSE 回调接它
    expect(page).toMatch(
      /const applyAssistantSnapshot = useCallback\(\(snap: AssistantSnapshot \| null\) => \{\s*streamControlsRef\.current\?\.applySnapshot\(snap\);\s*\}, \[\]\);/,
    );
    expect(page).toMatch(/onAssistantSnapshot: applyAssistantSnapshot/);
    expect(page).toContain("controlsRef={streamControlsRef}");
    // SSE 的 assistant_delta 仍然接 pushDelta
    expect(page).toMatch(/onAssistantDelta: pushDelta/);
  });

  it("SmoothEventStream：吐字 hook 在它里面，通过 useImperativeHandle 把 pushDelta / clearStreaming 暴露回页面", () => {
    expect(host).toContain("useSmoothStreaming()");
    expect(host).toContain("useImperativeHandle(");
    expect(host).toMatch(/\{ pushDelta, applySnapshot, clearStreaming \}/);
    expect(host).toContain("<EventStream");
    expect(host).toMatch(/streamingText=\{streamingText\}/);
  });

  it("isRunning 契约不因包一层而松动：页面显式传、包装组件显式透传（漏传 = 工具块全渲染成「已中断」）", () => {
    const at = page.indexOf("<SmoothEventStream");
    const tag = page.slice(at, page.indexOf("/>", at));
    // 第三轮 review：isRunning / mainRunActive 收进 deriveRunFlags（含渲染期吃 runStatus），页面不再手写 `||`
    expect(tag).toContain("isRunning={runFlags.isRunning}");
    expect(host).toMatch(/isRunning=\{isRunning\}/);
  });

  it("use-smooth-streaming 本体不动：步进公式 / 代理对保护原样（ChatView 仍直接用它）", () => {
    expect(hook).toContain("const step = Math.max(2, Math.ceil(remaining * 0.12));");
    expect(hook).toMatch(/displayedLenRef\.current = safeSliceEnd\(/);
  });
});

describe("② 传给 ArtifactPanel 的 props 必须稳定", () => {
  it("onArtifactRefClick 是 useCallback（空依赖、经 taskRef 读最新 actions），不再是 JSX 里的内联箭头", () => {
    expect(page).toMatch(/const handleArtifactRefClick = useCallback\(/);
    expect(page).toContain("onArtifactRefClick={handleArtifactRefClick}");
    expect(page).not.toMatch(/onArtifactRefClick=\{\(ref\)/);
  });

  it("repoShortNames 是 useMemo（依赖仓路径 key / 隔离标志 / action cwd），不再在 JSX 里每次 new 数组", () => {
    expect(page).toMatch(/const artifactRepoShortNames = useMemo\(/);
    expect(page).toContain("repoShortNames={artifactRepoShortNames}");
    expect(page).not.toMatch(/repoShortNames=\{\s*task\.repoPaths\.length/);
  });

  it("effectiveBatches / priorPlans / selectedAction 只跟 task.actions 走，事件追加（task 换引用、actions 不变）不重算", () => {
    expect(page).toMatch(/const taskActions = task\?\.actions;/);
    expect(page).toMatch(/const selectedAction = useMemo<ActionRecord \| null>\([\s\S]*?\[taskActions, selectedActionId\]/);
    expect(page).toMatch(/const effectiveBatches = useMemo\([\s\S]*?\[taskActions\]/);
    expect(page).toMatch(/const priorPlans = useMemo\([\s\S]*?\[taskActions, selectedAction\]/);
    // HANDOFF 警告：别把 liveToolOutputs 之类每帧变的对象喂给扫全量 events 的 memo
    // （memo 体都很短，取声明后 700 字符的窗口；liveToolOutputs 在页面里只出现在声明和 JSX 两处，离得很远）
    for (const name of ["selectedAction", "effectiveBatches", "priorPlans", "artifactRepoShortNames"]) {
      const at = page.indexOf(`const ${name} = useMemo`);
      expect(at, name).toBeGreaterThan(-1);
      expect(page.slice(at, at + 700), name).not.toContain("liveToolOutputs");
    }
  });

  it("repoShortNames 的依赖是仓路径 key 字符串，不是每帧换引用的 task.repoPaths 数组", () => {
    expect(page).toMatch(/\[repoPathsKey, isolateWorktree, selectedActionCwd\]/);
  });
});

describe("③ ArtifactPanel 自己 memo", () => {
  it("导出的是 memo(ArtifactPanelImpl)，名字不变（页面 import 不用改）", () => {
    expect(panel).toMatch(/const ArtifactPanelImpl = \(\{/);
    expect(panel).toMatch(/export const ArtifactPanel = memo\(ArtifactPanelImpl\);/);
    expect(panel).toMatch(/import \{[^}]*\bmemo\b[^}]*\} from "react";/);
  });

  it("components 的 useMemo 依赖仍是 [pathLinker, repoShortNames, onArtifactRefClick]（稳定性来自调用方，而不是去掉依赖）", () => {
    expect(panel).toMatch(
      /buildMarkdownComponents\(pathLinker, repoShortNames, onArtifactRefClick\),\s*\[pathLinker, repoShortNames, onArtifactRefClick\]/,
    );
  });
});
