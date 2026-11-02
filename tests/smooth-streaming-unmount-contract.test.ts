/**
 * useSmoothStreaming 卸载时必须取消未决 rAF（评审 P3：卸载后合帧 / 追赶回调仍会跑、对已卸载组件 setState）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/components/tasks/use-smooth-streaming.ts"),
  "utf8",
);

describe("useSmoothStreaming 卸载清理", () => {
  it("有一个空依赖的 effect，其 cleanup 取消 deltaRaf / smoothRaf 并置 null", () => {
    const m = /useEffect\(\s*\(\) => \(\) => \{([\s\S]*?)\},\s*\[\],\s*\);/.exec(src);
    expect(m, "应有 useEffect(() => () => { …cancelAnimationFrame… }, [])").not.toBeNull();
    const body = m![1]!;
    expect(body).toContain("deltaRafRef");
    expect(body).toContain("smoothRafRef");
    expect(body).toContain("cancelAnimationFrame(ref.current)");
    expect(body).toContain("ref.current = null");
  });
});
