/**
 * 分支命名模板：未知占位符校验 + 渲染整串清洗 + isSafeBranchName
 */
import { describe, expect, it } from "vitest";

import {
  findUnknownPlaceholders,
  guardRepoBranchTemplates,
  isSafeBranchName,
  renderBranchName,
  sanitizeBranchName,
  sanitizeBranchSegment,
} from "@/lib/branch-template";

describe("findUnknownPlaceholders", () => {
  it("合法模板（含 date 格式）→ 空数组", () => {
    expect(
      findUnknownPlaceholders("feature/{storyId}-{taskTitle}"),
    ).toEqual([]);
    expect(
      findUnknownPlaceholders("feature/{date:yyMMdd}-{taskTitle}"),
    ).toEqual([]);
    expect(
      findUnknownPlaceholders("feat/{date:yyyy-MM-dd}/{storyId}"),
    ).toEqual([]);
  });

  it("常见 typo {yyMMdd}（漏写 date:）→ 报出原文", () => {
    expect(
      findUnknownPlaceholders("feature/{yyMMdd}-{taskTitle}"),
    ).toEqual(["{yyMMdd}"]);
  });

  it("{date:} 空格式 → 未知", () => {
    expect(findUnknownPlaceholders("feature/{date:}-x")).toEqual([
      "{date:}",
    ]);
  });

  it("已废弃 {username} 放行（历史配置可能残留）", () => {
    expect(
      findUnknownPlaceholders("feature/{username}/{storyId}"),
    ).toEqual([]);
  });

  it("无花括号 → 合法", () => {
    expect(findUnknownPlaceholders("feature/hardcoded-name")).toEqual([]);
    expect(findUnknownPlaceholders("")).toEqual([]);
  });
});

describe("renderBranchName 整串清洗（含模板字面量）", () => {
  it("占位符值非法字符仍清洗；模板字面 $ ; 等也洗掉", () => {
    expect(
      renderBranchName("feature/{storyId}-{taskTitle}", {
        storyId: "123",
        taskTitle: "修 bug",
      }),
    ).toBe("feature/123-修-bug");
    // 字面量带 $() / 空格 / 分号 → 整串再过 sanitizeBranchName
    expect(
      renderBranchName("feat$ure/{storyId}", { storyId: "99" }),
    ).toBe("feat-ure/99");
    expect(
      renderBranchName("a;b/{storyId}", { storyId: "1" }),
    ).toBe("a-b/1");
  });

  it("保留 / 作路径分隔、连续 / 折叠", () => {
    expect(
      renderBranchName("feature//{storyId}//x", { storyId: "1" }),
    ).toBe("feature/1/x");
  });
});

describe("isSafeBranchName / sanitizeBranchName", () => {
  it("合法 feature 名放行", () => {
    expect(isSafeBranchName("feature/123-测")).toBe(true);
    expect(isSafeBranchName("v1.0.0")).toBe(true);
  });

  it("拒空串、前导 -、空白、..、非法 ref 字符", () => {
    expect(isSafeBranchName("")).toBe(false);
    expect(isSafeBranchName("  ")).toBe(false);
    expect(isSafeBranchName("-evil")).toBe(false);
    expect(isSafeBranchName("a b")).toBe(false);
    expect(isSafeBranchName("a..b")).toBe(false);
    expect(isSafeBranchName("a;b")).toBe(false);
    expect(isSafeBranchName("a$(x)")).toBe(false);
    expect(isSafeBranchName("a^b")).toBe(false);
  });

  it("sanitizeBranchName 分段清洗并保留 /", () => {
    expect(sanitizeBranchName("a;b/c d")).toBe("a-b/c-d");
  });
});

describe("guardRepoBranchTemplates（S13-01：其它保存动作不能把坏模板带进落盘）", () => {
  const persisted = [
    { path: "/a", name: "a", branchTemplate: "feature/{storyId}" },
    { path: "/b", name: "b" },
  ];

  it("草稿含字面量 {yyMMdd} 的仓 → 落盘值回退旧模板、blocked 报出该仓", () => {
    const draft = [
      { path: "/a", name: "a-renamed", branchTemplate: "feat/{yyMMdd}" },
      { path: "/b", name: "b" },
    ];
    const { repos, blocked } = guardRepoBranchTemplates(draft, persisted);
    expect(blocked).toEqual(["/a"]);
    // 其它字段（改名）照常落盘、只有坏模板被顶替
    expect(repos[0]).toMatchObject({
      name: "a-renamed",
      branchTemplate: "feature/{storyId}",
    });
    expect(repos[1]).toBe(draft[1]);
  });

  it("旧值不存在（新仓 / 原本没配）→ 回落 undefined（用全局模板）", () => {
    const { repos, blocked } = guardRepoBranchTemplates(
      [{ path: "/b", name: "b", branchTemplate: "x/{yyMMdd}" }],
      persisted,
    );
    expect(blocked).toEqual(["/b"]);
    expect(repos[0].branchTemplate).toBeUndefined();
  });

  it("旧值自己也非法（历史脏数据）→ 不沿用、清空", () => {
    const { repos } = guardRepoBranchTemplates(
      [{ path: "/a", name: "a", branchTemplate: "{bad}" }],
      [{ path: "/a", name: "a", branchTemplate: "{old-bad}" }],
    );
    expect(repos[0].branchTemplate).toBeUndefined();
  });

  it("全部合法 → 原样返回、blocked 为空", () => {
    const draft = [
      { path: "/a", name: "a", branchTemplate: "feat/{date:yyMMdd}-{taskTitle}" },
    ];
    const { repos, blocked } = guardRepoBranchTemplates(draft, persisted);
    expect(blocked).toEqual([]);
    expect(repos[0]).toBe(draft[0]);
  });
});

// ---------------------------------------------------------------------------
// 白名单清洗：任意任务标题渲染出的分支名必过 isSafeBranchName
// （旧实现是「黑名单替换 + 白名单校验」两套口径：全角标点 / 弯引号 / # / emoji 等原样保留 → 任务启动抛「任务分支名非法」）
// ---------------------------------------------------------------------------
describe("renderBranchName：中文真实标题（全角标点 / emoji / 弯引号 …）必过 isSafeBranchName", () => {
  const titles = [
    "修复登录页，验证码不显示",
    "支付：优化回调！",
    "「新版」首页改版",
    "《规范》更新",
    "用户反馈“无法提交”问题",
    "it's broken",
    "issue #123 修复",
    "折扣 100% + 优惠券",
    "🔥 紧急修复线上问题",
    "café 菜单适配",
    "【前端】订单列表（二期）",
    "a/b\\c:d*e?f",
    "v1.2.3 发布",
    "纯中文无标点",
  ];

  it.each(titles)("标题「%s」→ 合法分支名", (taskTitle) => {
    const name = renderBranchName("feature/{storyId}-{taskTitle}", {
      storyId: "6789012345",
      taskTitle,
    });
    expect(isSafeBranchName(name)).toBe(true);
    expect(name.startsWith("feature/6789012345")).toBe(true);
  });

  it("中文保留、全角标点变 -", () => {
    expect(
      renderBranchName("feature/{storyId}-{taskTitle}", {
        storyId: "1",
        taskTitle: "修复登录页，验证码不显示！",
      }),
    ).toBe("feature/1-修复登录页-验证码不显示");
  });

  it("段尾 .lock / 前导点 / 连续点都被处理", () => {
    expect(sanitizeBranchSegment("foo.lock")).toBe("foo-lock");
    // 大小写不敏感文件系统上 .LOCK 与 .lock 同名，一并处理
    expect(sanitizeBranchSegment("FOO.LOCK")).toBe("FOO-lock");
    expect(sanitizeBranchSegment(".hidden")).toBe("hidden");
    expect(sanitizeBranchSegment("a...b")).toBe("a-b");
    expect(sanitizeBranchSegment("   ")).toBe("");
    expect(sanitizeBranchSegment("--x--")).toBe("x");
  });

  it("标题全是 emoji / 空白 + 模板只有 {taskTitle} → 兜底 feature/{storyId}-{时间戳}", () => {
    const now = new Date(2026, 9, 23, 9, 5, 7);
    const name = renderBranchName(
      "{taskTitle}",
      { storyId: "42", taskTitle: "🔥🔥 " },
      now,
    );
    expect(name).toBe("feature/42-20261023-090507");
    expect(isSafeBranchName(name)).toBe(true);
    // storyId 也缺 → task
    expect(
      renderBranchName("{taskTitle}", { taskTitle: "🔥" }, now),
    ).toBe("feature/task-20261023-090507");
  });

  it("模板字面量本身非法（整段是 emoji）也能兜底", () => {
    const name = renderBranchName("🚀", { storyId: "7" }, new Date(2026, 0, 2, 3, 4, 5));
    expect(isSafeBranchName(name)).toBe(true);
    expect(name).toBe("feature/7-20260102-030405");
  });

  it("属性测试：固定种子的随机 Unicode 标题，渲染结果全部通过 isSafeBranchName", () => {
    // mulberry32：固定种子、可复现
    let a = 0x9e3779b9;
    const rand = (): number => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pools = [
      "abcXYZ019 ._-/\\:*?\"<>|~^@`$!&;()[]{}",
      "，。！？：；“”‘’、《》【】（）「」…—·",
      "修复订单列表登录页验证码支付优惠券",
      "🔥🚀✅éüñßçΩЖ日本語한국어\u0000\u200b\ufeff\n\t",
      "#%+=,'",
    ];
    for (let i = 0; i < 5000; i++) {
      const len = 1 + Math.floor(rand() * 40);
      let title = "";
      for (let j = 0; j < len; j++) {
        const pool = pools[Math.floor(rand() * pools.length)];
        const cps = [...pool];
        title += cps[Math.floor(rand() * cps.length)];
      }
      const name = renderBranchName("feature/{storyId}-{taskTitle}", {
        storyId: String(Math.floor(rand() * 1e10)),
        taskTitle: title,
      });
      if (!isSafeBranchName(name)) {
        throw new Error(
          `标题 ${JSON.stringify(title)} → ${JSON.stringify(name)} 未通过 isSafeBranchName`,
        );
      }
    }
  });

  it("isSafeBranchName：分量级 .lock / 前导点（git check-ref-format 要求）", () => {
    expect(isSafeBranchName("feature/x.lock/y")).toBe(false);
    expect(isSafeBranchName("feature/.hidden")).toBe(false);
    expect(isSafeBranchName("feature/x.lock")).toBe(false);
    expect(isSafeBranchName("feature/a.b-c_d/测试")).toBe(true);
  });
});
