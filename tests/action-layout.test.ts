/**
 * action-layout 纯函数：排序 / 显隐 / 删 id 清理
 */
import { describe, expect, it } from "vitest";

import {
  arrangeByLayout,
  removeActionLayoutId,
  sortByOrder,
} from "@/lib/action-layout";

describe("removeActionLayoutId（D10）", () => {
  it("从 order / hidden 同步清掉目标 id、其它保留", () => {
    const next = removeActionLayoutId(
      {
        order: ["plan", "my-custom", "build", "other"],
        hidden: ["my-custom", "ship"],
      },
      "my-custom",
    );
    expect(next).toEqual({
      order: ["plan", "build", "other"],
      hidden: ["ship"],
    });
  });

  it("id 不在布局里 → 等长原样（可跳过 save）", () => {
    const layout = { order: ["plan", "build"], hidden: ["ship"] };
    const next = removeActionLayoutId(layout, "gone");
    expect(next.order).toEqual(layout.order);
    expect(next.hidden).toEqual(layout.hidden);
  });
});

describe("sortByOrder / arrangeByLayout 冒烟", () => {
  it("order 优先、hidden 过滤", () => {
    expect(sortByOrder(["build", "plan", "ship"], ["ship", "plan"])).toEqual([
      "ship",
      "plan",
      "build",
    ]);
    expect(
      arrangeByLayout(["plan", "build", "ship"], {
        order: ["ship", "plan"],
        hidden: ["build"],
      }),
    ).toEqual(["ship", "plan"]);
  });
});
