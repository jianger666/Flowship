/**
 * 提测收件箱纯函数：MR 链接提取 / URL 去重 / 90 天清理 / 节点过滤；
 * 二期：bug MQL 解析 / 状态白名单 / bug URL / 角色分组 / 去修指令。
 */
import { describe, expect, it } from "vitest";

import {
  BUG_PENDING_FIX_LABELS,
  BUG_STATUS,
  buildBugDetailUrl,
  buildFixBugInstruction,
  buildInboxNotifyCopy,
  buildStoryUrlFromBug,
  dedupeMrCandidatesByUrl,
  diffInboxUnreadForNotify,
  extractMrUrlsFromText,
  findNodeByNamePattern,
  formatUnreadBadge,
  inboxGroupsVisibleForRole,
  isBugPendingFixStatus,
  isBugPendingRegressionStatus,
  isNodeStatusDone,
  isWorkitemReadyForQaInbox,
  listUnreadInboxItems,
  MR_INBOX_SEEN_MAX_AGE_MS,
  normalizeInboxSeenUrl,
  parseGitlabMrUrl,
  parseMoqlBugQueryResponse,
  parseMoqlBugRow,
  pickLatestMrUrlFromComments,
  pruneSeenMap,
  truncateCommentSnippet,
  type MoqlField,
  type MrUrlCandidate,
} from "@/lib/mr-inbox";

describe("extractMrUrlsFromText", () => {
  it("markdown 链接 [url](url) 同串重复只留一个", () => {
    const text =
      "- crm-web [https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968](https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968)";
    expect(extractMrUrlsFromText(text)).toEqual([
      "https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968",
    ]);
  });

  it("一段文本多个不同 MR 全部提取", () => {
    const text = [
      "前端 https://gitlab.example.com/fe/web/-/merge_requests/12",
      "后端 https://gitlab.example.com/be/api/-/merge_requests/34",
    ].join("\n");
    expect(extractMrUrlsFromText(text)).toEqual([
      "https://gitlab.example.com/fe/web/-/merge_requests/12",
      "https://gitlab.example.com/be/api/-/merge_requests/34",
    ]);
  });

  it("URL 后跟标点 / 括号不吞进链接", () => {
    expect(
      extractMrUrlsFromText(
        "见 https://gitlab.example.com/g/r/-/merge_requests/5。",
      ),
    ).toEqual(["https://gitlab.example.com/g/r/-/merge_requests/5"]);
    expect(
      extractMrUrlsFromText(
        "（https://gitlab.example.com/g/r/-/merge_requests/6）",
      ),
    ).toEqual(["https://gitlab.example.com/g/r/-/merge_requests/6"]);
  });

  it("非 MR 链接 / 无链接文本返回空", () => {
    expect(extractMrUrlsFromText("纯文字、没有链接")).toEqual([]);
    expect(
      extractMrUrlsFromText("仓库主页 https://gitlab.example.com/g/r 不算"),
    ).toEqual([]);
  });

  it("子组多级路径可解析", () => {
    expect(
      extractMrUrlsFromText(
        "https://gitlab.example.com/group/sub/repo/-/merge_requests/99",
      ),
    ).toEqual(["https://gitlab.example.com/group/sub/repo/-/merge_requests/99"]);
  });
});

describe("pickLatestMrUrlFromComments", () => {
  const c = (content: string, createdAtMs: number) => ({ content, createdAtMs });

  it("取最新评论里最新出现的那个 MR", () => {
    const out = pickLatestMrUrlFromComments([
      c(
        "旧 https://gitlab.example.com/a/b/-/merge_requests/1",
        100,
      ),
      c(
        [
          "先 https://gitlab.example.com/a/b/-/merge_requests/2",
          "后 https://gitlab.example.com/a/b/-/merge_requests/3",
        ].join("\n"),
        200,
      ),
    ]);
    expect(out).toBe("https://gitlab.example.com/a/b/-/merge_requests/3");
  });

  it("最新评论无 MR 时回落到更早含 MR 的评论", () => {
    const out = pickLatestMrUrlFromComments([
      c("https://gitlab.example.com/a/b/-/merge_requests/9", 50),
      c("纯文字、没有链接", 300),
    ]);
    expect(out).toBe("https://gitlab.example.com/a/b/-/merge_requests/9");
  });

  it("无 MR 返回 undefined", () => {
    expect(
      pickLatestMrUrlFromComments([c("没有链接", 1), c("还是没有", 2)]),
    ).toBeUndefined();
    expect(pickLatestMrUrlFromComments([])).toBeUndefined();
  });

  it("markdown 同串重复链接去重后仍能取到唯一 MR", () => {
    const url =
      "https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968";
    const out = pickLatestMrUrlFromComments([
      c(`- crm-web [${url}](${url})`, 10),
    ]);
    expect(out).toBe(url);
  });
});

describe("parseGitlabMrUrl", () => {
  it("标准 MR URL → host / projectPath / iid", () => {
    expect(
      parseGitlabMrUrl(
        "https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968",
      ),
    ).toEqual({
      host: "gitlab.wukongedu.net",
      projectPath: "frontend/crm-web",
      iid: 3968,
      canonicalUrl:
        "https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3968",
    });
  });

  it("带 query / hash / 尾斜杠归一到 canonical", () => {
    const parsed = parseGitlabMrUrl(
      "https://gitlab.example.com/g/r/-/merge_requests/7?tab=diffs#note_1",
    );
    expect(parsed?.canonicalUrl).toBe(
      "https://gitlab.example.com/g/r/-/merge_requests/7",
    );
    expect(
      parseGitlabMrUrl("https://gitlab.example.com/g/r/-/merge_requests/7/")
        ?.canonicalUrl,
    ).toBe("https://gitlab.example.com/g/r/-/merge_requests/7");
  });

  it("非 MR URL 返回 null", () => {
    expect(parseGitlabMrUrl("https://gitlab.example.com/g/r")).toBeNull();
    expect(parseGitlabMrUrl("not a url")).toBeNull();
  });
});

describe("normalizeInboxSeenUrl", () => {
  it("MR URL 归一到 canonical（去 query / 尾斜杠）", () => {
    expect(
      normalizeInboxSeenUrl(
        "https://gitlab.example.com/g/r/-/merge_requests/7/?tab=diffs",
      ),
    ).toBe("https://gitlab.example.com/g/r/-/merge_requests/7");
  });

  it("非 MR URL（bug 链接）原样保留", () => {
    const bug =
      "https://project.feishu.cn/xxx/issue/detail/123456?parentUrl=%2Fwork";
    expect(normalizeInboxSeenUrl(bug)).toBe(bug);
    expect(normalizeInboxSeenUrl("  ")).toBe("");
  });
});

describe("dedupeMrCandidatesByUrl", () => {
  const c = (mrUrl: string, atMs: number, content = ""): MrUrlCandidate => ({
    mrUrl,
    atMs,
    commentContent: content,
  });

  it("同 URL 多条取最新时间那条", () => {
    const out = dedupeMrCandidatesByUrl([
      c("https://g.com/a/b/-/merge_requests/1", 100, "旧"),
      c("https://g.com/a/b/-/merge_requests/1", 200, "新"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.atMs).toBe(200);
    expect(out[0]!.commentContent).toBe("新");
  });

  it("query 差异归一后视为同一 MR", () => {
    const out = dedupeMrCandidatesByUrl([
      c("https://g.com/a/b/-/merge_requests/1?tab=diffs", 100),
      c("https://g.com/a/b/-/merge_requests/1", 50),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.mrUrl).toBe("https://g.com/a/b/-/merge_requests/1");
  });

  it("不同 MR 保留、按时间倒序", () => {
    const out = dedupeMrCandidatesByUrl([
      c("https://g.com/a/b/-/merge_requests/1", 100),
      c("https://g.com/a/b/-/merge_requests/2", 300),
    ]);
    expect(out.map((x) => x.atMs)).toEqual([300, 100]);
  });

  it("附加字段（泛型）原样保留", () => {
    const out = dedupeMrCandidatesByUrl([
      { ...c("https://g.com/a/b/-/merge_requests/1", 1), workItemId: "w1" },
    ]);
    expect(out[0]!.workItemId).toBe("w1");
  });
});

describe("pruneSeenMap", () => {
  const now = 1_800_000_000_000;

  it("超 90 天的条目被清掉", () => {
    const seen = {
      fresh: now - 1000,
      stale: now - MR_INBOX_SEEN_MAX_AGE_MS - 1,
    };
    expect(pruneSeenMap(seen, now)).toEqual({ fresh: now - 1000 });
  });

  it("恰好 90 天边界保留", () => {
    const seen = { edge: now - MR_INBOX_SEEN_MAX_AGE_MS };
    expect(pruneSeenMap(seen, now)).toEqual(seen);
  });

  it("无变化返回原引用（调用方 === 判断可不写盘）", () => {
    const seen = { a: now - 1 };
    expect(pruneSeenMap(seen, now)).toBe(seen);
  });

  it("非法值（NaN / 非数字）清掉", () => {
    const seen = { bad: Number.NaN, ok: now };
    expect(pruneSeenMap(seen, now)).toEqual({ ok: now });
  });
});

describe("isNodeStatusDone / findNodeByNamePattern", () => {
  it("finished / done 判完成、doing / not_started / 空判未完成", () => {
    expect(isNodeStatusDone("finished")).toBe(true);
    expect(isNodeStatusDone("done")).toBe(true);
    expect(isNodeStatusDone("Finished")).toBe(true);
    expect(isNodeStatusDone("doing")).toBe(false);
    expect(isNodeStatusDone("not_started")).toBe(false);
    expect(isNodeStatusDone(undefined)).toBe(false);
    expect(isNodeStatusDone("")).toBe(false);
  });

  it("精确名优先、否则包含匹配取最短名", () => {
    const nodes = [
      { name: "测试案例评审", status: "finished" },
      { name: "提测及冒烟测试", status: "finished" },
      { name: "测试", status: "doing" },
    ];
    expect(findNodeByNamePattern(nodes, "测试")?.name).toBe("测试");
    const noExact = [
      { name: "测试案例评审", status: "finished" },
      { name: "功能测试", status: "doing" },
    ];
    expect(findNodeByNamePattern(noExact, "测试")?.name).toBe("功能测试");
    expect(findNodeByNamePattern(nodes, "")).toBeUndefined();
  });
});

describe("isWorkitemReadyForQaInbox（单条件：测试未完成）", () => {
  it("「测试」未完成 → 纳入（不看提测节点状态）", () => {
    expect(
      isWorkitemReadyForQaInbox([
        { name: "提测及冒烟测试", status: "doing" },
        { name: "测试", status: "not_started" },
      ]),
    ).toBe(true);
    expect(
      isWorkitemReadyForQaInbox([
        { name: "提测及冒烟测试", status: "finished" },
        { name: "测试", status: "doing" },
      ]),
    ).toBe(true);
  });

  it("「测试」已完成 → 不纳入", () => {
    expect(
      isWorkitemReadyForQaInbox([
        { name: "提测及冒烟测试", status: "finished" },
        { name: "测试", status: "finished" },
      ]),
    ).toBe(false);
  });

  it("缺「测试」节点 → 不纳入", () => {
    expect(
      isWorkitemReadyForQaInbox([{ name: "产品评审", status: "doing" }]),
    ).toBe(false);
    expect(isWorkitemReadyForQaInbox([])).toBe(false);
  });

  it("节点名微调（包含匹配）仍能命中", () => {
    expect(
      isWorkitemReadyForQaInbox([{ name: "测试验收", status: "doing" }]),
    ).toBe(true);
  });
});

describe("truncateCommentSnippet / formatUnreadBadge", () => {
  it("去 HTML 注释（mention 元数据）+ 压空白 + 截断", () => {
    const raw =
      'MR 已提交：\n\n@李晓忱<!-- mention:{"id":"7227"} --> 请测试\n';
    const out = truncateCommentSnippet(raw);
    expect(out).not.toContain("mention:");
    expect(out).toContain("@李晓忱");
    expect(out).not.toContain("\n");
  });

  it("markdown 链接拆成文本 + URL、超长截断带省略号", () => {
    const raw = `前置说明 [link](https://g.com/a/b/-/merge_requests/1) ${"字".repeat(200)}`;
    const out = truncateCommentSnippet(raw, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("badge：0 不显示、1-99 原样、超 99 显示 99+", () => {
    expect(formatUnreadBadge(0)).toBe("");
    expect(formatUnreadBadge(5)).toBe("5");
    expect(formatUnreadBadge(99)).toBe("99");
    expect(formatUnreadBadge(100)).toBe("99+");
  });
});

describe("parseMoqlBugRow / parseMoqlBugQueryResponse", () => {
  // ⚠️ 真实 CLI 形状（2026-07-14 实测 workitem query 响应）：value 按 value_type
  // 包了一层同名壳。旧样本用裸值形状、测试全绿但线上漏扫（"[object Object]" + 空状态）。
  const sampleFields = (): MoqlField[] => [
    {
      key: "name",
      name: "名称",
      value: { string_value: "登录页白屏" },
      value_type: "string_value",
    },
    {
      key: "work_item_id",
      name: "工作项id",
      value: { long_value: 7042596005 },
      value_type: "long_value",
    },
    {
      key: "work_item_status",
      name: "状态",
      value: { key_label_value_list: [{ key: "Not started", label: "OPEN" }] },
      value_type: "key_label_value_list",
    },
    {
      key: "priority",
      name: "优先级",
      value: { key_label_value: { key: "hx_9mx804", label: "P1" } },
      value_type: "key_label_value",
    },
    {
      key: "field_cf759f",
      name: "关联产品需求",
      value: {
        key_label_value_list: [{ key: "6012345678", label: "学员端登录改版" }],
      },
      value_type: "key_label_value_list",
    },
  ];

  it("moql_field_list → 归一 bug 行（真实形状样本：value 带 value_type 壳）", () => {
    const row = parseMoqlBugRow(sampleFields());
    expect(row).toEqual({
      workItemId: "7042596005",
      name: "登录页白屏",
      statusLabel: "OPEN",
      statusKey: "Not started",
      priorityLabel: "P1",
      relatedStoryId: "6012345678",
      relatedStoryName: "学员端登录改版",
    });
  });

  it("裸值旧形状仍兼容", () => {
    const row = parseMoqlBugRow([
      { name: "名称", value: "白屏", value_type: "string_value" },
      { name: "工作项id", value: 42, value_type: "long_value" },
      {
        name: "状态",
        value: { key: "Not started", label: "OPEN" },
        value_type: "key_label_value",
      },
    ]);
    expect(row).toMatchObject({
      workItemId: "42",
      name: "白屏",
      statusLabel: "OPEN",
    });
  });

  it("缺 id 或名称 → null", () => {
    expect(
      parseMoqlBugRow([
        {
          name: "名称",
          value: { string_value: "只有标题" },
          value_type: "string_value",
        },
      ]),
    ).toBeNull();
  });

  it("query 响应 data.<group>[] 展开多行", () => {
    const resp = {
      data: {
        group_a: [{ moql_field_list: sampleFields() }],
        group_b: [
          {
            moql_field_list: [
              {
                name: "名称",
                value: { string_value: "另一条" },
                value_type: "string_value",
              },
              {
                name: "工作项id",
                value: { string_value: "99" },
                value_type: "string_value",
              },
              {
                name: "状态",
                value: {
                  key_label_value_list: [
                    { key: "fYFKOOeAM", label: "RESOLVED" },
                  ],
                },
                value_type: "key_label_value_list",
              },
            ],
          },
        ],
      },
    };
    const rows = parseMoqlBugQueryResponse(resp);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("登录页白屏");
    expect(rows[1]!.statusLabel).toBe("RESOLVED");
  });
});

describe("bug 状态白名单", () => {
  it("待修：OPEN / IN PROGRESS / REOPENED；RESOLVED 不算", () => {
    expect(isBugPendingFixStatus("OPEN")).toBe(true);
    expect(isBugPendingFixStatus("IN PROGRESS")).toBe(true);
    expect(isBugPendingFixStatus("REOPENED")).toBe(true);
    expect(isBugPendingFixStatus("RESOLVED")).toBe(false);
    expect(isBugPendingFixStatus("CLOSED")).toBe(false);
    expect(BUG_PENDING_FIX_LABELS).toContain(BUG_STATUS.OPEN.label);
  });

  it("待回归：仅 RESOLVED", () => {
    expect(isBugPendingRegressionStatus("RESOLVED")).toBe(true);
    expect(isBugPendingRegressionStatus("OPEN")).toBe(false);
    expect(isBugPendingRegressionStatus("closed")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isBugPendingFixStatus("open")).toBe(true);
    expect(isBugPendingRegressionStatus("resolved")).toBe(true);
  });
});

describe("buildBugDetailUrl / buildFixBugInstruction / inboxGroupsVisibleForRole", () => {
  it("优先 host + simpleName 拼 URL", () => {
    expect(
      buildBugDetailUrl({
        projectKey: "proj_key",
        workItemId: "123",
        host: "project.feishu.cn",
        simpleName: "wk-dm",
      }),
    ).toBe("https://project.feishu.cn/wk-dm/bug/detail/123");
  });

  it("缺 simpleName 回落 projectKey；缺 host 用 project.feishu.cn", () => {
    expect(
      buildBugDetailUrl({ projectKey: "abc", workItemId: "9" }),
    ).toBe("https://project.feishu.cn/abc/bug/detail/9");
  });

  it("改bug 指令含标题 / 链接 / 关联需求；不带行为约束（约束在 fix-bug skill 里）", () => {
    const text = buildFixBugInstruction({
      bugTitle: "白屏",
      bugUrl: "https://project.feishu.cn/x/bug/detail/1",
      storyName: "登录改版",
    });
    expect(text).toContain("改bug：白屏");
    expect(text).toContain("https://project.feishu.cn/x/bug/detail/1");
    expect(text).toContain("关联需求：登录改版");
    expect(text).not.toContain("ask_user");
  });

  it("buildStoryUrlFromBug：从 bug URL 推导同空间 story URL", () => {
    expect(
      buildStoryUrlFromBug(
        "https://project.feishu.cn/wk-dm/bug/detail/7049704722",
        "6985042801",
      ),
    ).toBe("https://project.feishu.cn/wk-dm/story/detail/6985042801");
    // 带 query 的 bug URL 也能推
    expect(
      buildStoryUrlFromBug(
        "https://project.feishu.cn/wk-dm/bug/detail/1?parentUrl=%2Fabc",
        "42",
      ),
    ).toBe("https://project.feishu.cn/wk-dm/story/detail/42");
    // 无 storyId / URL 不含 detail 段 → null
    expect(
      buildStoryUrlFromBug("https://project.feishu.cn/wk-dm/bug/detail/1"),
    ).toBeNull();
    expect(buildStoryUrlFromBug("https://project.feishu.cn/wk-dm", "42")).toBeNull();
  });

  it("角色显隐：fe/be 仅我的 BUG；qa 待测+待回归；未设全显", () => {
    expect([...inboxGroupsVisibleForRole("fe")].sort()).toEqual(["myBugs"]);
    expect([...inboxGroupsVisibleForRole("be")].sort()).toEqual(["myBugs"]);
    expect([...inboxGroupsVisibleForRole("qa")].sort()).toEqual([
      "pendingMr",
      "pendingRegression",
    ]);
    expect([...inboxGroupsVisibleForRole(undefined)].sort()).toEqual([
      "myBugs",
      "pendingMr",
      "pendingRegression",
    ]);
    expect([...inboxGroupsVisibleForRole("other")].sort()).toEqual([
      "myBugs",
      "pendingMr",
      "pendingRegression",
    ]);
  });
});

describe("三期注意力：diff 新增未读 + 通知文案", () => {
  const groups = (opts: {
    mrs?: Array<{ url: string; title: string; seen?: boolean }>;
    bugs?: Array<{ url: string; name: string; seen?: boolean }>;
    regs?: Array<{ url: string; name: string; seen?: boolean }>;
  }) => ({
    pendingMr: (opts.mrs ?? []).map((m) => ({
      mrUrl: m.url,
      workItemName: m.title,
      mr: { title: m.title },
      seenAtMs: m.seen ? 1 : null,
    })),
    myBugs: (opts.bugs ?? []).map((b) => ({
      bugUrl: b.url,
      name: b.name,
      seenAtMs: b.seen ? 1 : null,
    })),
    pendingRegression: (opts.regs ?? []).map((b) => ({
      bugUrl: b.url,
      name: b.name,
      seenAtMs: b.seen ? 1 : null,
    })),
  });

  it("listUnreadInboxItems 只收未见、跳过已读", () => {
    const items = listUnreadInboxItems(
      groups({
        mrs: [
          { url: "mr-1", title: "MR甲" },
          { url: "mr-2", title: "MR乙", seen: true },
        ],
        bugs: [{ url: "bug-1", name: "白屏" }],
        regs: [{ url: "bug-2", name: "回归X", seen: true }],
      }),
    );
    expect(items.map((i) => i.key)).toEqual(["mr-1", "bug-1"]);
    expect(items[0]?.title).toBe("MR甲");
  });

  it("首轮 prevKeys=null：不通知（存量建基线）", () => {
    const current = listUnreadInboxItems(
      groups({
        mrs: [{ url: "mr-1", title: "存量MR" }],
        bugs: [{ url: "bug-1", name: "存量BUG" }],
      }),
    );
    const r = diffInboxUnreadForNotify(null, current);
    expect(r.notify).toBe(false);
    expect(r.newItems).toEqual([]);
  });

  it("增量：上轮没有的未读才进 newItems", () => {
    const prev = new Set(["mr-1", "bug-1"]);
    const current = listUnreadInboxItems(
      groups({
        mrs: [
          { url: "mr-1", title: "旧MR" },
          { url: "mr-2", title: "新MR" },
        ],
        bugs: [{ url: "bug-1", name: "旧BUG" }],
        regs: [{ url: "bug-new", name: "新回归" }],
      }),
    );
    const r = diffInboxUnreadForNotify(prev, current);
    expect(r.notify).toBe(true);
    expect(r.newItems.map((i) => i.key).sort()).toEqual(["bug-new", "mr-2"]);
  });

  it("已有未读不重复推（集合不变 → 不通知）", () => {
    const prev = new Set(["mr-1"]);
    const current = listUnreadInboxItems(
      groups({ mrs: [{ url: "mr-1", title: "同一条" }] }),
    );
    const r = diffInboxUnreadForNotify(prev, current);
    expect(r.notify).toBe(false);
    expect(r.newItems).toEqual([]);
  });

  it("空集合基线后出现未读 = 增量通知", () => {
    const r = diffInboxUnreadForNotify(
      new Set(),
      listUnreadInboxItems(
        groups({ bugs: [{ url: "bug-x", name: "新来的" }] }),
      ),
    );
    expect(r.notify).toBe(true);
    expect(r.newItems).toHaveLength(1);
  });

  it("单条通知文案用具体标题", () => {
    expect(
      buildInboxNotifyCopy([{ key: "a", title: "登录白屏" }]),
    ).toEqual({
      title: "登录白屏",
      body: "收件箱新增待处理",
    });
  });

  it("多条合并成一条文案", () => {
    expect(
      buildInboxNotifyCopy([
        { key: "a", title: "MR甲" },
        { key: "b", title: "BUG乙" },
        { key: "c", title: "回归丙" },
      ]),
    ).toEqual({
      title: "收件箱",
      body: "收件箱新增 3 条待处理：MR甲 等",
    });
  });

  it("空列表不生成文案", () => {
    expect(buildInboxNotifyCopy([])).toBeNull();
  });
});
