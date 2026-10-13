/**
 * 产物面板：拉取失败 ≠ 没有产物。
 *
 * 以前 fetchActionRevisions 失败（断网 / 5xx）且退避重试耗尽后只 console.warn，面板落到
 * `!currentArtifact` 分支显示「没有产物」——把「没拉到」说成「不存在」，用户没法区分也没法重试。
 * 现在：最终失败落 loadError，空态分支显示「加载产物失败：… + 重试」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "src/components/tasks/artifact-panel.tsx",
  ),
  "utf-8",
);

/** 取「拉产物」effect 的 load 函数体：从 fetchActionRevisions 调用到 finally 块 */
const loadBody = (() => {
  const start = src.indexOf("await fetchActionRevisions(taskId, action.id)");
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf("setContentLoading(false)", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
})();

describe("产物拉取失败的 UI 契约", () => {
  it("有 loadError / loadRetryKey 两个 state", () => {
    expect(src).toMatch(
      /const \[loadError, setLoadError\] = useState<string \| null>\(null\)/,
    );
    expect(src).toMatch(/const \[loadRetryKey, setLoadRetryKey\] = useState\(0\)/);
  });

  it("拉取成功清错误态（否则重试成功后错误提示残留）", () => {
    const successPart = loadBody.slice(0, loadBody.indexOf("} catch"));
    expect(successPart).toContain("setLoadError(null)");
  });

  it("只有「不再重试」的最终失败才落 loadError（重试中保持 loading、不闪错误）", () => {
    const catchPart = loadBody.slice(loadBody.indexOf("} catch"));
    expect(catchPart).toMatch(/if \(!willRetry\) \{\s*setLoadError\(/);
  });

  it("重试按钮递增 loadRetryKey、且 loadRetryKey 在拉取 effect 的依赖里", () => {
    expect(src).toMatch(
      /const handleLoadRetry = useCallback\(\(\) => \{\s*setLoadRetryKey\(\(k\) => k \+ 1\);/,
    );
    // 拉产物 effect 的依赖数组（紧跟 action.artifactUpdatedAt）
    expect(src).toMatch(/action\.artifactUpdatedAt,\s*loadRetryKey,\s*\]\)/);
  });

  it("空态分支：loadError 优先于「没有产物」，且带重试按钮", () => {
    const emptyStart = src.indexOf("!currentArtifact ? (");
    expect(emptyStart).toBeGreaterThan(0);
    const emptyBlock = src.slice(emptyStart, src.indexOf("/* content area */"));
    const errIdx = emptyBlock.indexOf("loadError ? (");
    const noneIdx = emptyBlock.indexOf("没有产物");
    expect(errIdx).toBeGreaterThan(-1);
    expect(noneIdx).toBeGreaterThan(errIdx); // 先判错误、后落「没有产物」
    expect(emptyBlock).toContain("加载产物失败：");
    expect(emptyBlock).toContain("onClick={handleLoadRetry}");
  });
});
