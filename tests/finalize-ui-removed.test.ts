/**
 * 2026-11-12：去掉任务页的「已合入 / 放弃」两个按钮（归档已经够用）。
 *
 * 钉住「去干净了」：页面 / 客户端 / 路由三处都没有入口，且没误伤周边——
 *  - 「恢复」（reopen）还在：老数据里有 61 个 merged / abandoned 的任务，要靠它拉回来；
 *  - 终态任务的只读展示还在（状态徽标、推进 / 停止按钮的显隐）；
 *  - 事件流里历史上那句「任务已标记为已合入」仍能显示；
 *  - 服务端 finalizeTask 函数保留（大批 ownership 矩阵测试落在它上面，不在这次范围）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

describe("已合入 / 放弃：入口去干净", () => {
  const page = read("src/app/tasks/[id]/page.tsx");

  it("任务页：没有两个按钮、没有确认处理函数、没有 canFinalize 判定、不再 import 客户端 finalizeTask", () => {
    expect(page).not.toContain("handleFinalize");
    expect(page).not.toContain("canFinalize");
    expect(page).not.toMatch(/\bfinalizeTask\b/);
    // 按钮文案（JSX 里的纯文本节点）：已合入 / 放弃
    expect(page).not.toMatch(/>\s*已合入\s*</);
    expect(page).not.toMatch(/>\s*放弃\s*</);
    // 按钮图标也不该残留成死 import：只看 lucide-react 的 import 清单（不扫全文——注释里提到这个词不算残留）
    const lucide = [...page.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)]
      .flatMap((m) => m[1].split(","))
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    expect(lucide.length).toBeGreaterThan(0);
    expect(lucide).not.toContain("Flag");
    expect(lucide).not.toContain("XCircle");
  });

  it("客户端 task-store：没有 finalizeTask 导出，也没有任何地方 fetch /finalize", () => {
    const store = read("src/lib/task-store.ts");
    expect(store).not.toMatch(/export const finalizeTask\b/);
    expect(store).not.toContain("/finalize");
  });

  it("服务端路由文件已删除", () => {
    expect(existsSync(path.join(root, "src/app/api/tasks/[id]/finalize/route.ts"))).toBe(false);
  });

  it("src 里没有任何地方还在请求 /finalize 接口", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          // 只看代码行：注释里提到这个路径（解释为什么删）不算
          const code = read(rel)
            .split("\n")
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
            .join("\n");
          if (/\/api\/tasks\/[^"'`]*\/finalize/.test(code)) offenders.push(rel);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

describe("没误伤周边", () => {
  const page = read("src/app/tasks/[id]/page.tsx");

  it("「恢复」还在：终态任务要靠它拉回开发中", () => {
    expect(page).toContain("handleReopen");
    expect(page).toContain("canReopen");
    expect(page).toMatch(/task\.repoStatus === "merged" \|\| task\.repoStatus === "abandoned"/);
    expect(read("src/lib/task-store.ts")).toMatch(/export const reopenTask\b/);
  });

  it("服务端 finalizeTask 与 reopenTask 都还在导出（矩阵测试依赖）", () => {
    const runner = read("src/lib/server/task-runner.ts");
    expect(runner).toMatch(/export const finalizeTask = async \(/);
    expect(runner).toMatch(/export const reopenTask = async \(/);
  });
});
