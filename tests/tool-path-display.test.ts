/**
 * V4-07：工具块折叠行的路径展示。
 *
 * 旧行为：摘要 = 绝对路径 + ` +N/−M` 整串放进一个 `truncate` span，行尾被吃——先吃掉 +N/−M、再吃文件名
 * （task 事件流栏默认只有约 307px，业务仓绝对路径动辄 100+ 字）。
 * 新做法：显示层剥 baseDir 前缀 → 拆成「目录 / 文件名」两段（目录可被 CSS 省略、文件名钉住）→ +N/−M 单独钉右。
 * 这里是纯函数部分；接线用源码契约断言（文件尾）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isToolBlock, mergeToolDisplayEvents, toolBlockSummary } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

import {
  ROW_TOOLTIP_MIN_CHARS,
  splitPathForDisplay,
  stripBaseDirPrefix,
  toolPathRowParts,
  toolRowTooltipText,
  resolveRowTooltip,
} from "../src/lib/tool-path-display";

describe("stripBaseDirPrefix：显示层剥 baseDir 前缀", () => {
  it("POSIX：在 baseDir 之下 → 相对路径；带不带尾斜杠的 baseDir 都行", () => {
    expect(stripBaseDirPrefix("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(stripBaseDirPrefix("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(stripBaseDirPrefix("/repo/src/a.ts", "/repo//")).toBe("src/a.ts");
  });

  it("必须落在目录边界上：/repo-x/a.ts 不是 /repo 的子路径", () => {
    expect(stripBaseDirPrefix("/repo-x/a.ts", "/repo")).toBe("/repo-x/a.ts");
    expect(stripBaseDirPrefix("/repository/a.ts", "/repo")).toBe(
      "/repository/a.ts",
    );
  });

  it("不在 baseDir 之下 / 没有 baseDir / 路径本身就是 baseDir → 原样（不会剥成空串）", () => {
    expect(stripBaseDirPrefix("/tmp/x.ts", "/repo")).toBe("/tmp/x.ts");
    expect(stripBaseDirPrefix("/repo/src/a.ts", undefined)).toBe("/repo/src/a.ts");
    expect(stripBaseDirPrefix("/repo/src/a.ts", "")).toBe("/repo/src/a.ts");
    expect(stripBaseDirPrefix("/repo/src/a.ts", null)).toBe("/repo/src/a.ts");
    expect(stripBaseDirPrefix("/repo", "/repo")).toBe("/repo");
    expect(stripBaseDirPrefix("/repo/", "/repo")).toBe("/repo/");
  });

  it("根目录 baseDir `/`：不把所有绝对路径都剥成相对（那没有信息量）", () => {
    expect(stripBaseDirPrefix("/etc/hosts", "/")).toBe("/etc/hosts");
  });

  it("相对路径本来就短：原样", () => {
    expect(stripBaseDirPrefix("src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("Windows 盘符路径：反斜杠 / 正斜杠混用、盘符大小写不敏感，结果保留原路径的分隔符风格", () => {
    expect(
      stripBaseDirPrefix("C:\\Users\\me\\repo\\src\\a.ts", "C:\\Users\\me\\repo"),
    ).toBe("src\\a.ts");
    // baseDir 来自服务端（正斜杠），路径来自 SDK（反斜杠）
    expect(
      stripBaseDirPrefix("C:\\Users\\me\\repo\\src\\a.ts", "C:/Users/me/repo"),
    ).toBe("src\\a.ts");
    // 盘符大小写不同
    expect(
      stripBaseDirPrefix("c:/Users/me/repo/src/a.ts", "C:\\Users\\me\\repo\\"),
    ).toBe("src/a.ts");
    // Windows 路径整体大小写不敏感（NTFS）
    expect(
      stripBaseDirPrefix("C:\\USERS\\me\\Repo\\a.ts", "c:\\users\\ME\\repo"),
    ).toBe("a.ts");
    // 不同盘
    expect(
      stripBaseDirPrefix("D:\\repo\\a.ts", "C:\\repo"),
    ).toBe("D:\\repo\\a.ts");
    // 边界
    expect(
      stripBaseDirPrefix("C:\\repo-x\\a.ts", "C:\\repo"),
    ).toBe("C:\\repo-x\\a.ts");
  });

  it("POSIX 路径大小写敏感（/Repo 不是 /repo）", () => {
    expect(stripBaseDirPrefix("/Repo/a.ts", "/repo")).toBe("/Repo/a.ts");
  });
});

describe("splitPathForDisplay：目录 / 文件名", () => {
  it("POSIX", () => {
    expect(splitPathForDisplay("src/lib/foo.ts")).toEqual({
      dir: "src/lib/",
      base: "foo.ts",
    });
    expect(splitPathForDisplay("/a/b/c.ts")).toEqual({
      dir: "/a/b/",
      base: "c.ts",
    });
  });

  it("没有目录 → dir 为空", () => {
    expect(splitPathForDisplay("foo.ts")).toEqual({ dir: "", base: "foo.ts" });
  });

  it("Windows 反斜杠 / 盘符", () => {
    expect(splitPathForDisplay("C:\\repo\\src\\a.ts")).toEqual({
      dir: "C:\\repo\\src\\",
      base: "a.ts",
    });
    expect(splitPathForDisplay("src\\a.ts")).toEqual({
      dir: "src\\",
      base: "a.ts",
    });
  });

  it("目录路径带尾斜杠：最后一段（含尾斜杠）算文件名那一段，不返回空 base", () => {
    expect(splitPathForDisplay("src/lib/")).toEqual({
      dir: "src/",
      base: "lib/",
    });
  });

  it("拼回去恒等于原路径（不丢字符）", () => {
    for (const p of [
      "a",
      "/",
      "/a",
      "a/b",
      "C:\\a\\b.ts",
      "/a/b/",
      "a//b.ts",
    ]) {
      const { dir, base } = splitPathForDisplay(p);
      expect(dir + base, p).toBe(p);
    }
  });
});

describe("toolPathRowParts：折叠行的三段（目录 / 文件名 / 统计）+ Tooltip 全文", () => {
  it("edit：剥 baseDir、统计单独成段、full 保留未剥的原路径", () => {
    const r = toolPathRowParts({
      filePath: "/Users/me/proj/src/components/tasks/event-stream/tool-block.tsx",
      baseDir: "/Users/me/proj",
      stats: { added: 12, removed: 3 },
    });
    expect(r).toEqual({
      dir: "src/components/tasks/event-stream/",
      base: "tool-block.tsx",
      stats: "+12/−3",
      full: "/Users/me/proj/src/components/tasks/event-stream/tool-block.tsx",
    });
  });

  it("没有统计（read / write 无 diff）→ stats 为 null", () => {
    const r = toolPathRowParts({
      filePath: "/repo/a.ts",
      baseDir: "/repo",
      stats: null,
    });
    expect(r.stats).toBeNull();
    expect(r.dir).toBe("");
    expect(r.base).toBe("a.ts");
  });

  it("统计 +0/−0 也如实显示（edit 只改了空白也是一次编辑）", () => {
    expect(
      toolPathRowParts({
        filePath: "a.ts",
        stats: { added: 0, removed: 0 },
      }).stats,
    ).toBe("+0/−0");
  });

  it("baseDir 还没拉到 / 路径在 baseDir 之外 → 展示完整路径，不抛", () => {
    expect(
      toolPathRowParts({ filePath: "/tmp/x/y.ts", baseDir: undefined }).dir,
    ).toBe("/tmp/x/");
    expect(
      toolPathRowParts({ filePath: "/tmp/x/y.ts", baseDir: "/repo" }).dir,
    ).toBe("/tmp/x/");
  });

  it("Windows：盘符路径 + 反斜杠 baseDir", () => {
    const r = toolPathRowParts({
      filePath: "C:\\work\\app\\src\\index.ts",
      baseDir: "C:/work/app",
      stats: { added: 1, removed: 0 },
    });
    expect(r.dir).toBe("src\\");
    expect(r.base).toBe("index.ts");
    expect(r.full).toBe("C:\\work\\app\\src\\index.ts");
  });
});

describe("toolRowTooltipText：折叠行整行 Tooltip 的内容", () => {
  const parts = toolPathRowParts({
    filePath: "/repo/src/a.ts",
    baseDir: "/repo",
    stats: { added: 1, removed: 2 },
  });

  it("路径行：永远是未剥前缀的完整路径（显示的已经被剥 / 省略过）", () => {
    expect(
      toolRowTooltipText({
        summary: "/repo/src/a.ts +1/−2",
        pathParts: parts,
      }),
    ).toBe("/repo/src/a.ts");
  });

  it("非路径行：短摘要不挂（避免每行都闪一遍原文），够长才挂摘要全文", () => {
    const short = "$ ls -la";
    const long = "$ " + "a".repeat(ROW_TOOLTIP_MIN_CHARS);
    expect(toolRowTooltipText({ summary: short, pathParts: null })).toBe("");
    expect(toolRowTooltipText({ summary: long, pathParts: null })).toBe(long);
    // 边界：恰好 MIN_CHARS 个字就挂
    expect(
      toolRowTooltipText({
        summary: "a".repeat(ROW_TOOLTIP_MIN_CHARS - 1),
        pathParts: null,
      }),
    ).toBe("");
    expect(
      toolRowTooltipText({
        summary: "a".repeat(ROW_TOOLTIP_MIN_CHARS),
        pathParts: null,
      }),
    ).not.toBe("");
  });
});

/**
 * 接线契约：折叠行的路径摘要必须按「目录可省略 / 文件名钉住 / 统计钉右」三段渲染，且整行挂 Tooltip。
 * 只做类名 / 结构契约：没有在浏览器里看过实际渲染（见汇报）。
 */
describe("tool-block.tsx 折叠行路径摘要接线（源码契约）", () => {
  const SRC = readFileSync(
    path.join(
      __dirname,
      "../src/components/tasks/event-stream/tool-block.tsx",
    ),
    "utf8",
  );

  it("用 toolPathRowParts 拆段，baseDir 对任何带文件路径的块都拉取（不再只对相对路径）", () => {
    expect(SRC).toMatch(/toolPathRowParts\(/);
    expect(SRC).toMatch(/useTaskBaseDir\(\s*taskId,\s*!!filePath,/);
  });

  it("目录段可被省略、文件名段 shrink-0、统计段 shrink-0（+N/−M 先被吃的老问题不复发）", () => {
    // 目录段：min-w-0 + truncate
    expect(SRC).toMatch(/data-path-dir[\s\S]{0,200}?min-w-0[^"]*truncate|min-w-0[^"]*truncate[^"]*"[\s\S]{0,80}?data-path-dir/);
    // 文件名段：shrink-0 + max-w-full 兜底超长文件名；min-w-0 必须有（truncate 的 flex item 默认 min-width:auto
    // = 整串文字宽，min 压过 max，超长文件名会溢出而不是截断——ui-conventions 那条）
    expect(SRC).toMatch(
      /data-path-base\s+className="min-w-0 max-w-full shrink-0 truncate"/,
    );
    expect(SRC).toMatch(/data-path-base[\s\S]{0,200}?shrink-0|shrink-0[^"]*"[\s\S]{0,80}?data-path-base/);
    // 统计段
    expect(SRC).toMatch(/data-path-stats[\s\S]{0,200}?shrink-0|shrink-0[^"]*"[\s\S]{0,80}?data-path-stats/);
  });

  it("折叠行整行包 Tooltip（不是原生 title），嵌套在动词组里的块同样有", () => {
    expect(SRC).toMatch(/<Tooltip\s+content=\{rowTooltip\}/);
    // 同一个 RegularToolBlockRow 既服务顶层块也服务 nested 块——没有 nested 分支绕开 Tooltip
    expect(SRC).not.toMatch(/nested\s*\?\s*<button|!nested\s*&&\s*<Tooltip/);
    expect(SRC).not.toMatch(/\btitle=\{/);
  });
});

describe("R7-03：整行 Tooltip 的挂载决定跨渲染稳定（运行中 → 完成不重挂行按钮）", () => {
  // 真实管线：未映射工具（submit_mr）运行中 summary 是 `调用 submit_mr:{json…}`，完成后变输出首行 `ok`
  const mk = (kind: string, id: string, extra: Record<string, unknown> = {}) =>
    ({ id, ts: 1, kind, text: kind, ...extra }) as unknown as TaskEvent;
  const callEv = mk("tool_call", "c1", {
    text: `调用 submit_mr:${JSON.stringify({ title: "把很长很长很长很长的标题放进去", source_branch: "feature/abc", target_branch: "main" })}`,
    meta: {
      callId: "k1",
      name: "submit_mr",
      args: JSON.stringify({ title: "把很长很长很长很长的标题放进去", source_branch: "feature/abc", target_branch: "main" }),
    },
  });
  const resEv = mk("tool_result", "r1", {
    text: "ok",
    meta: { callId: "k1", name: "submit_mr", status: "success", output: "ok" },
  });
  const blockOf = (events: TaskEvent[]) => {
    const items = mergeToolDisplayEvents(events);
    const b = items.find(isToolBlock);
    if (!b || !isToolBlock(b)) throw new Error("no block");
    return b;
  };

  it("前提：旧口径下 running 的 summary ≥32 字有 Tooltip、完成后 <32 字没有（这就是翻转点）", () => {
    const running = blockOf([callEv]);
    const done = blockOf([callEv, resEv]);
    const sRun = toolBlockSummary(running);
    const sDone = toolBlockSummary(done);
    expect(toolRowTooltipText({ summary: sRun, pathParts: null }).length).toBeGreaterThan(0);
    expect(toolRowTooltipText({ summary: sDone, pathParts: null })).toBe("");
  });

  it("新口径：逐帧（运行中 → 完成 → 再渲染）content 始终非空，闩锁只增不减", () => {
    const frames = [
      { b: blockOf([callEv]), running: true },
      { b: blockOf([callEv]), running: true },
      { b: blockOf([callEv, resEv]), running: false },
      { b: blockOf([callEv, resEv]), running: false },
    ];
    let mounted = false;
    for (const f of frames) {
      const r = resolveRowTooltip({
        summary: toolBlockSummary(f.b),
        pathParts: null,
        running: f.running,
        mounted,
        fallback: f.b.name,
      });
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.mounted).toBe(true);
      mounted = r.mounted;
    }
  });

  it("运行中短摘要（<32）的行也挂 → 完成后摘要变长时不会「无 → 有」重挂", () => {
    const r1 = resolveRowTooltip({ summary: "$ ls", pathParts: null, running: true, mounted: false, fallback: "shell" });
    expect(r1.mounted).toBe(true);
    expect(r1.content).toBe("$ ls");
    const r2 = resolveRowTooltip({ summary: "x".repeat(80), pathParts: null, running: false, mounted: r1.mounted, fallback: "shell" });
    expect(r2).toEqual({ content: "x".repeat(80), mounted: true });
  });

  it("D5-02 的省法保持：一上来就是完成态、内容为空的行不挂", () => {
    expect(resolveRowTooltip({ summary: "ok", pathParts: null, running: false, mounted: false, fallback: "x" })).toEqual({
      content: "",
      mounted: false,
    });
  });

  it("性质：任意 running / 摘要长度序列，mounted 闩锁单调、挂了之后 content 恒非空", () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 0x100000000;
    };
    for (let round = 0; round < 300; round++) {
      let mounted = false;
      for (let step = 0; step < 8; step++) {
        const summary = "a".repeat(Math.floor(rnd() * 70));
        const r = resolveRowTooltip({ summary, pathParts: null, running: rnd() < 0.4, mounted, fallback: "tool" });
        if (mounted) expect(r.mounted).toBe(true);
        if (r.mounted) expect(r.content.length).toBeGreaterThan(0);
        mounted = r.mounted;
      }
    }
  });
});
