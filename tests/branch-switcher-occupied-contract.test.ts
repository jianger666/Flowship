/**
 * 分支选择器：被其他工作树占用的分支 → 置灰 + 说明（源码契约闸）
 *
 * ⚠ 这是**弱保护**：vitest 是 node 环境、没有 DOM，这里只能断言「关键写法还在」，
 * 断不了「界面上真的灰了 / hover 真的出 Tooltip」。占用关系怎么算、文案是什么，
 * 由 tests/git-worktree-occupancy.test.ts 与 tests/git-branches-occupancy.integration.test.ts 真测；
 * 本文件只钉组件接线，并把「为什么这么写」放在断言旁边——这几处都是看着多余、一「清理」就回到旧缺陷的写法。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...seg: string[]): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", ...seg), "utf-8");

// 去掉块注释 / 行注释：契约管真正生效的代码，注释里解释旧写法时会点名被禁的字串
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const switcher = stripComments(
  read("src", "components", "tasks", "branch-switcher.tsx"),
);
const gitBranches = stripComments(
  read("src", "lib", "server", "git-branches.ts"),
);

describe("BranchSwitcher：占用行", () => {
  it("用共享的 occupantOf 取占用者（只认自有属性），不自己 occupied[b]", () => {
    expect(switcher).toMatch(
      /from\s+"@\/lib\/git-branch-occupancy"/,
    );
    expect(switcher).toContain("occupantOf(state?.occupied, b)");
    // 分支可以叫 constructor / toString：直接下标会命中 Object.prototype、把普通分支误判成被占用
    expect(switcher).not.toMatch(/occupied\??\.?\[\s*b\s*\]/);
  });

  it("占用行用 aria-disabled、不用原生 disabled——否则 hover 不到、Tooltip 出不来", () => {
    expect(switcher).toContain("aria-disabled={occupant ? true : undefined}");
    // 原生 disabled 仍只管「保存中 / 拉取中」（并发 checkout 会撞 index.lock）
    expect(switcher).toContain("disabled={saving || refreshing}");
    // (?<!aria-)：aria-disabled={occupant …} 本身是对的、别被这条反向断言误伤
    expect(switcher).not.toMatch(/(?<!aria-)disabled=\{[^}]*occupant/);
  });

  it("点击守卫：占用行点了 / 键盘回车都不能走进 handleCheckout", () => {
    // aria-disabled 不拦 click，所以必须在 onClick 里自己拦；守卫要先于 handleCheckout
    const m = switcher.match(/onClick=\{\(\) => \{([\s\S]*?)\}\}/);
    expect(m, "未找到占用行的 onClick").not.toBeNull();
    const body = m![1]!;
    const guard = body.indexOf("if (occupant) return;");
    const call = body.indexOf("handleCheckout(b)");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(guard);
  });

  it("占用行不 hover 高亮、可点的行才有 hover:bg-accent（高亮 = 暗示可点）", () => {
    const m = switcher.match(
      /occupant\s*\?\s*("[^"]*cursor-not-allowed[^"]*")\s*:\s*"hover:bg-accent"/,
    );
    expect(m, "未找到占用行 / 可点行的 className 分流").not.toBeNull();
    // 占用那一支里不许出现任何 hover: 变体
    expect(m![1]).not.toContain("hover:");
  });

  it("名字下面写明占在哪（hint）；hover 用 Tooltip 给完整路径和办法（项目约定：禁用原生 title）", () => {
    expect(switcher).toContain("occupiedBranchHint(occupant)");
    expect(switcher).toMatch(
      /<Tooltip\s+content=\{occupiedBranchMessage\(b,\s*occupant\)\}/,
    );
    // ui-conventions「Hover 提示」：交互提示一律 Tooltip、不用原生 title 当 tip
    expect(switcher).not.toMatch(/\btitle=\{?\s*occupant/);
  });

  it("当前分支永远不算占用（防御：服务端本就不会列它）", () => {
    expect(switcher).toMatch(
      /const occupant = selected\s*\?\s*undefined\s*:\s*occupantOf\(/,
    );
  });
});

describe("服务端：切换前复查占用", () => {
  it("checkoutGitBranch 在 git checkout 之前先查 worktree 列表、命中就返回我们自己的说明", () => {
    const start = gitBranches.indexOf("export const checkoutGitBranch");
    expect(start).toBeGreaterThan(0);
    const body = gitBranches.slice(start);
    const precheck = body.indexOf("occupiedBranchMessage(b, occupant)");
    const checkout = body.indexOf('["checkout", b]');
    expect(precheck).toBeGreaterThan(0);
    expect(checkout).toBeGreaterThan(precheck);
  });

  it("占用判定走 porcelain，不解析 git 的 checkout 报错文案（中英文措辞不同、还随 git 版本改过）", () => {
    expect(gitBranches).toContain('"worktree", "list", "--porcelain"');
    expect(gitBranches).not.toMatch(/已经检出|already checked out|is already used by worktree/i);
  });

  it("git-branches 保持叶子模块：不 import task-worktrees / task-fs（会在测试里惰性触发 boot-recovery）", () => {
    expect(gitBranches).not.toMatch(/from\s+"\.\/task-(worktrees|fs)/);
  });
});
