/**
 * UI 字号下限守卫：`.cursor/rules/ui-conventions.mdc` 明令「不许再出现 10px」
 * （字号阶梯最小一档是 11px `text-[11px]`）。
 *
 * 规则靠人记会漂：group-qa-panel 曾留着 4 处 `text-[10px]`（含 `/70` 透明度叠加，浅色下对比度 < 3.3:1）。
 * 这里全 src 扫一遍，新增 ≤10px 的文字类直接红。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(p);
  }
  return out;
};

describe("UI 字号下限 ≥ 11px", () => {
  it("src 里没有 text-[8px] / text-[9px] / text-[10px]", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf-8");
      const re = /text-\[(?:[0-9]|10)px\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${path.relative(SRC, file)}:${line} ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("群问答面板（曾违规处）的文字不再叠透明度", () => {
    const text = readFileSync(
      path.join(SRC, "components/tasks/group-qa-panel.tsx"),
      "utf-8",
    );
    expect(text).not.toMatch(/text-muted-foreground\/\d+/);
  });

  it("任务列表行的阶段 / 时间文字不再叠透明度（装饰分隔点与图标除外）", () => {
    const text = readFileSync(
      path.join(SRC, "components/tasks/task-list-item.tsx"),
      "utf-8",
    );
    // 阶段文字、右侧相对时间是真文字；`·` 分隔点（/40）与行首图标（/60）是装饰，约定允许 alpha
    expect(text).not.toContain("truncate text-muted-foreground/70");
    expect(text).not.toContain("tabular-nums text-muted-foreground/50");
  });
});
