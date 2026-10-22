/**
 * F3-03「加载失败当空」接线契约：会话管理页 / 工作项预览页
 *
 * 背景：列表首拉失败时 useTaskList 的 tasks 仍是空数组、loaded 照样为 true。
 * 侧栏和 /chats 早已按 loadError 分流（见 load-outcome.test.ts），但还有两处只看 loaded / 列表长度：
 *  - 会话管理页（/sessions）：失败时画「还没有对话」——像数据没了；
 *  - 工作项预览页（/workitems/[id]）：失败时查不到「已有任务」→ 放出启动表单 → 可对同一需求重复启动。
 *
 * 判定行为靠纯函数测（decideWorkitemGate → workitem-link.test.ts、deriveListLoadView → load-outcome.test.ts），
 * 这里只钉「页面真的接了」：UI 在 node 环境跑不起来，用 readFileSync + 正则做源码契约。
 * 弱保护：只能证明接线还在，**没有在浏览器里看过失败态的实际样子**。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 取 start 标记之后到 end 标记之前的片段；任一标记找不到就让测试在这里直接失败 */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a, `找不到起点标记：${start}`).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b, `找不到终点标记：${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("会话管理页：列表加载失败不画「还没有对话」", () => {
  const page = stripComments(read("src/app/sessions/page.tsx"));

  it("从 useTaskList 取了 loadError，并用 deriveListLoadView 判定（与侧栏 / /chats 同源）", () => {
    expect(page).toMatch(/const \{[^}]*\bloadError\b[^}]*\} = useTaskList\(\)/);
    expect(page).toContain('import { deriveListLoadView } from "@/lib/load-outcome"');
    expect(page).toMatch(
      /deriveListLoadView\(\{\s*loaded,\s*loadError,\s*count: tasks\.length,?\s*\}\)/,
    );
  });

  it("失败分支排在「空列表」分支之前，且带原因 + 重试（refresh）", () => {
    const failureIdx = page.indexOf('listView === "error"');
    const emptyIdx = page.indexOf("visible.length === 0");
    const emptyCopyIdx = page.indexOf("还没有对话");
    expect(failureIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(failureIdx);
    expect(emptyCopyIdx).toBeGreaterThan(failureIdx);

    const failureBlock = between(page, 'listView === "error"', "visible.length === 0");
    expect(failureBlock).toContain("加载失败：{loadError}");
    expect(failureBlock).toContain("重试");
    expect(failureBlock).toContain("void refresh()");
    // 失败块里不许出现「没有」的结论
    expect(failureBlock).not.toContain("还没有对话");
  });

  it("重试带 loading 态防连点（disabled + 转圈）", () => {
    const failureBlock = between(page, 'listView === "error"', "visible.length === 0");
    expect(failureBlock).toContain("disabled={retryingList}");
    expect(failureBlock).toContain("animate-spin");
  });
});

describe("工作项预览页：列表加载失败不放启动表单", () => {
  const page = stripComments(read("src/app/workitems/[id]/page.tsx"));

  it("从 useTaskList 取了 loadError / refresh，并连同 tasks.length 一起喂给 decideWorkitemGate", () => {
    expect(page).toMatch(/const \{[^}]*\bloadError\b[^}]*\} = useTaskList\(\)/);
    expect(page).toMatch(/const \{[^}]*\brefresh\b[^}]*\} = useTaskList\(\)/);
    const gateCall = between(page, "const gate = decideWorkitemGate({", "});");
    expect(gateCall).toMatch(/\bloadError\b/);
    expect(gateCall).toContain("taskCount: tasks.length");
  });

  it('gate === "error" 分支：带原因 + 重试，且分支内不渲染 TaskLaunchForm', () => {
    const start = page.indexOf('gate === "error" && (');
    expect(start, '找不到 gate === "error" 分支').toBeGreaterThan(-1);
    // 到下一个以 gate 起头的 JSX 分支为止
    const end = page.indexOf('gate !== "loading" && existing', start);
    expect(end).toBeGreaterThan(start);
    const block = page.slice(start, end);
    expect(block).toContain("加载失败：{loadError}");
    expect(block).toContain("重试");
    expect(block).toContain("void refresh()");
    expect(block).toContain("disabled={retrying}");
    expect(block).not.toContain("TaskLaunchForm");
  });

  it('TaskLaunchForm 仍只在 gate === "form" 下渲染（此处只做文本兜底，AST 级断言在 workitem-link.test.ts）', () => {
    const idx = page.indexOf("<TaskLaunchForm");
    expect(idx).toBeGreaterThan(-1);
    expect(page.slice(Math.max(0, idx - 80), idx)).toMatch(/gate === "form" && \(\s*$/);
    expect(page.match(/<TaskLaunchForm/g)).toHaveLength(1);
  });
});
