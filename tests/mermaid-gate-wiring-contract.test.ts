/**
 * mermaid 渲染入口接线契约（第七轮 R7-1 的收口）
 *
 * 上游 `@streamdown/mermaid` 的 `mermaid` 单例对标签里的 `<img>` / classDef 的 `url()` 不拦，渲染即向外发请求。
 * 所以 src 里**不许**再有人直接拿它的值（`import { mermaid } from "@streamdown/mermaid"`）塞进 Streamdown 的 plugins：
 * 三个渲染入口（对话 markdown / 产物栏 / 修订视图）一律用 markdown-text.tsx 导出的 `GATED_MERMAID`（预扫闸 + 安全配置）。
 * 以前产物栏和修订视图各自 import 了上游单例，只靠共用 rehype 表这一层挡——漏过一次，这里钉死。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(full);
  }
  return out;
};

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

describe("mermaid 入口接线", () => {
  it("src 里没有任何文件直接 import 上游的 `mermaid` 单例（只允许 createMermaidPlugin / 类型）", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf-8");
      // import { mermaid } / import { mermaid as x } / import { a, mermaid } from "@streamdown/mermaid"（type import 不算）
      const re = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+["']@streamdown\/mermaid["']/g;
      for (const m of text.matchAll(re)) {
        const names = m[1]
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n !== "" && !n.startsWith("type "));
        if (names.some((n) => /^mermaid(\s+as\s+\w+)?$/.test(n))) {
          offenders.push(path.relative(process.cwd(), file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("markdown-text 导出带闸的 GATED_MERMAID；产物栏 / 修订视图都用它", () => {
    expect(read("src/components/markdown-text.tsx")).toMatch(/export const GATED_MERMAID = createGatedMermaidPlugin\(/);
    for (const rel of ["src/components/tasks/artifact-panel.tsx", "src/components/tasks/artifact-revision-view.tsx"]) {
      const src = read(rel);
      expect(src, rel).toMatch(/import \{[^}]*\bGATED_MERMAID\b[^}]*\} from "@\/components\/markdown-text"/);
      expect(src, rel).toMatch(/mermaid:\s*GATED_MERMAID/);
    }
  });
});
