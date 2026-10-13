/**
 * UI「文字不靠透明度表达层级」全仓守卫（`.cursor/rules/ui-conventions.mdc`）。
 *
 * 约定：⛔ 文字上不许叠 `/40~/80` 这类 alpha——浅色下 `text-muted-foreground/70` 只有 3.3:1、`/50` 只有 2.2:1，
 * 低于 WCAG AA 的 4.5:1；更弱的层级靠 11px 档 + 位置表达。alpha 只留给装饰：图标、分隔符、拖拽把手、hover 显隐。
 *
 * 2026-10-13 一次性清掉了 20 个文件里的存量；这里全 src 扫，新增的「文字 + alpha」直接红。
 * 放行规则按**标签级**写（图标 / 装饰符 / 把手 / 注释），不按文件行号——挪动代码不会误报。
 * 真要加新的装饰例外，在 DECORATIVE 里补一条并写明理由，别把文字塞进来。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
};

/** 文字颜色 + 40~80 的 alpha */
const TEXT_ALPHA =
  /\btext-(?:muted-foreground|foreground|primary|brand|info|success|warning|destructive|subagent)\/(?:40|50|60|70|75|80)\b/;

/** 约定允许 alpha 的装饰：图标 / 分隔符 / 拖拽把手 / 注释 */
const DECORATIVE: Array<{ why: string; test: (line: string) => boolean }> = [
  { why: "注释", test: (l) => /^\s*(\*|\/\/|\/\*)/.test(l) },
  {
    why: "lucide 图标（<Xxx className=... /> 自闭合标签）",
    test: (l) => /<[A-Z][A-Za-z0-9]*\s[^>]*className="[^"]*text-/.test(l) && /\/>\s*$/.test(l),
  },
  { why: "动态图标变量 <Icon", test: (l) => /<Icon\s/.test(l) },
  { why: "装饰分隔符 · /", test: (l) => /<span[^>]*>(·|\/)<\/span>/.test(l) },
  { why: "拖拽把手", test: (l) => l.includes("cursor-grab") },
  {
    why: "图标态：状态色三元里的图标色（Plug / Sparkles 等）",
    test: (l) =>
      /isDisabled \? "text-muted-foreground\/40" : "text-success"/.test(l) ||
      /"text-muted-foreground\/60 group-hover:text-muted-foreground"/.test(l),
  },
  {
    why: "图标按钮（内容只有一个图标，色加在 Button 上）",
    test: (l) =>
      l.includes("text-muted-foreground/60 shrink-0 hover:bg-destructive/10 hover:text-destructive"),
  },
];

describe("文字不叠透明度（全 src 守卫）", () => {
  it("没有「文字 + /40~/80」（图标 / 装饰符 / 把手 / 注释除外）", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!TEXT_ALPHA.test(line)) return;
        if (DECORATIVE.some((d) => d.test(line))) return;
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("守卫自检：真文字 + alpha 会被抓、图标 / 分隔符不会（防正则写松 / 写死）", () => {
    const flagged = (l: string) => TEXT_ALPHA.test(l) && !DECORATIVE.some((d) => d.test(l));
    // 真文字：必须抓
    expect(flagged('<span className="text-[11px] text-muted-foreground/70">常用</span>')).toBe(true);
    expect(flagged('<div className="text-xs text-foreground/80">{hint}</div>')).toBe(true);
    expect(flagged('<span className="text-destructive/80">失败</span>')).toBe(true);
    // 约定允许：不抓
    expect(flagged('<Info className="size-3.5 shrink-0 text-muted-foreground/70" />')).toBe(false);
    expect(flagged('<span className="text-muted-foreground/40">·</span>')).toBe(false);
    expect(flagged(" * 浅色下 `text-muted-foreground/70` 只有 3.3:1")).toBe(false);
    // 不在 40~80 范围内的不管
    expect(flagged('<div className="text-xs text-foreground/90">x</div>')).toBe(false);
  });
});
