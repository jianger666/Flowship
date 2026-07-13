/**
 * 只读仓后置检测纯函数单测（diffReadonlyRepoState）
 *
 * 规则：不比 HEAD；porcelain / ahead-of-upstream 相对基线增量才 fail。
 */
import { describe, expect, it } from "vitest";

import { diffReadonlyRepoState } from "@/lib/server/action-checks";

describe("diffReadonlyRepoState", () => {
  it("基线干净 + 当前干净 → 通过", () => {
    expect(
      diffReadonlyRepoState(
        { porcelain: "", ahead: "" },
        { porcelain: "", ahead: "" },
      ),
    ).toEqual([]);
  });

  it("当前变脏 → fail 并列文件", () => {
    const fails = diffReadonlyRepoState(
      { porcelain: "", ahead: "" },
      { porcelain: " M src/a.ts\n?? new.ts", ahead: "" },
    );
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("工作区被改脏");
    expect(fails[0]).toContain("src/a.ts");
  });

  it("基线本就脏且未再变 → 通过（不因启动前脏状态误报）", () => {
    expect(
      diffReadonlyRepoState(
        { porcelain: " M src/a.ts", ahead: "" },
        { porcelain: " M src/a.ts", ahead: "" },
      ),
    ).toEqual([]);
  });

  it("本地多出 upstream 没有的 commit → fail", () => {
    const fails = diffReadonlyRepoState(
      { porcelain: "", ahead: "" },
      { porcelain: "", ahead: "abc1234 feat: bad commit" },
    );
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("本地多出 upstream 没有的 commit");
    expect(fails[0]).toContain("abc1234");
  });

  it("无 upstream（ahead=null）→ 跳过 ahead 比对", () => {
    expect(
      diffReadonlyRepoState(
        { porcelain: "", ahead: null },
        { porcelain: "", ahead: null },
      ),
    ).toEqual([]);
  });

  it("仅 HEAD 会变的场景（porcelain/ahead 不变）→ 通过", () => {
    // pull / 切提测分支：HEAD 动了但不在本函数比对范围内
    expect(
      diffReadonlyRepoState(
        { porcelain: "", ahead: "" },
        { porcelain: "", ahead: "" },
      ),
    ).toEqual([]);
  });
});
