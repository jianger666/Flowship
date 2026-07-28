/**
 * 需求群成员自动注册表：解析 / 合并 / 建群载荷挑选 / 自动注册（幂等·并发·静默失败）
 *
 * 全部 mock 外部调用——禁止真跑 lark-cli / meegle / git 网络。
 * 注册表落在团队库的 `members` 数据分支上，分支读写的**真 git** 行为
 *（建孤儿分支 / 不切主克隆 HEAD / 并发重试）在 `tests/team-library.test.ts` 里验。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetSelfRegistrationStateForTest,
  __setGroupRegistryDepsForTest,
  emptyGroupMemberRegistry,
  GROUP_MEMBERS_VERSION,
  isSameGroupMemberIdentity,
  mergeGroupMemberRegistries,
  normalizeMemberEmail,
  parseGroupMemberRegistry,
  pickGroupCreationTargets,
  registerSelfToGroupRegistry,
  scheduleSelfRegistration,
  serializeGroupMemberRegistry,
  type GroupMemberRegistry,
  type RegistryWriteResult,
} from "@/lib/server/feishu-group-registry";
import {
  parseUserSearchEmail,
  parseWorkitemRoleMembers,
} from "@/lib/server/meegle-cli";

afterEach(() => {
  __setGroupRegistryDepsForTest(null);
  __resetSelfRegistrationStateForTest();
});

/** 造一张注册表（省掉重复的 version 字段） */
const registryOf = (
  members: GroupMemberRegistry["members"],
): GroupMemberRegistry => ({ version: GROUP_MEMBERS_VERSION, members });

// ----------------- 纯函数 -----------------

describe("normalizeMemberEmail", () => {
  it("trim + 小写；非邮箱一律空串（姓名 / user_key 不能当 key）", () => {
    expect(normalizeMemberEmail("  Edison@Example.COM ")).toBe(
      "edison@example.com",
    );
    // 角色成员列表里常混进这些——拿它们当 key 会污染整张表
    expect(normalizeMemberEmail("陈禄江")).toBe("");
    expect(normalizeMemberEmail("7135920133214732291")).toBe("");
    expect(normalizeMemberEmail("no-at-sign")).toBe("");
    expect(normalizeMemberEmail(undefined)).toBe("");
  });
});

describe("parseGroupMemberRegistry", () => {
  it("正常内容 → 规范化 key + 保留字段", () => {
    const reg = parseGroupMemberRegistry(
      JSON.stringify({
        version: 1,
        members: {
          "Edison@Example.com": {
            openId: "ou_a",
            botAppId: "cli_a",
            name: "陈禄江",
            updatedAt: 100,
          },
        },
      }),
    );
    expect(reg.members["edison@example.com"]).toEqual({
      openId: "ou_a",
      botAppId: "cli_a",
      name: "陈禄江",
      updatedAt: 100,
    });
  });

  it("坏 JSON / 空 / 结构不对 → 空表（绝不抛）", () => {
    expect(parseGroupMemberRegistry(null).members).toEqual({});
    expect(parseGroupMemberRegistry("").members).toEqual({});
    expect(parseGroupMemberRegistry("{ 半截").members).toEqual({});
    expect(parseGroupMemberRegistry("[1,2]").members).toEqual({});
    expect(parseGroupMemberRegistry('{"members":[]}').members).toEqual({});
  });

  it("坏一条不牵连整表：缺 openId 跳过、botAppId 允许空、非邮箱 key 丢弃", () => {
    const reg = parseGroupMemberRegistry(
      JSON.stringify({
        members: {
          "good@x.com": { openId: "ou_g", botAppId: "", updatedAt: 5 },
          "noopenid@x.com": { botAppId: "cli_b", updatedAt: 9 },
          陈禄江: { openId: "ou_bad", botAppId: "cli_c", updatedAt: 9 },
          "nested@x.com": "字符串不是对象",
        },
      }),
    );
    expect(Object.keys(reg.members)).toEqual(["good@x.com"]);
    expect(reg.members["good@x.com"]!.botAppId).toBe("");
  });

  it("同邮箱大小写写了两条（历史脏数据）→ updatedAt 新者胜", () => {
    const reg = parseGroupMemberRegistry(
      JSON.stringify({
        members: {
          "a@x.com": { openId: "ou_old", botAppId: "cli_old", updatedAt: 1 },
          "A@X.com": { openId: "ou_new", botAppId: "cli_new", updatedAt: 2 },
        },
      }),
    );
    expect(reg.members["a@x.com"]!.openId).toBe("ou_new");
  });
});

describe("serializeGroupMemberRegistry", () => {
  it("email 升序 + 尾换行：多人并发写时 diff 最小、不因遍历顺序抖出假变更", () => {
    const a = serializeGroupMemberRegistry(
      registryOf({
        "z@x.com": { openId: "ou_z", botAppId: "cli_z", updatedAt: 2 },
        "a@x.com": { openId: "ou_a", botAppId: "cli_a", updatedAt: 1 },
      }),
    );
    const b = serializeGroupMemberRegistry(
      registryOf({
        "a@x.com": { openId: "ou_a", botAppId: "cli_a", updatedAt: 1 },
        "z@x.com": { openId: "ou_z", botAppId: "cli_z", updatedAt: 2 },
      }),
    );
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.indexOf("a@x.com")).toBeLessThan(a.indexOf("z@x.com"));
    // 解析 → 序列化 → 解析 稳定
    expect(parseGroupMemberRegistry(a)).toEqual(parseGroupMemberRegistry(b));
  });
});

describe("mergeGroupMemberRegistries", () => {
  it("按 email 逐条合并：新者胜、相等保留 base、别人的条目原样保留", () => {
    const base = registryOf({
      "me@x.com": { openId: "ou_old", botAppId: "cli_old", updatedAt: 100 },
      "peer@x.com": { openId: "ou_p", botAppId: "cli_p", updatedAt: 300 },
    });
    const incoming = registryOf({
      "me@x.com": { openId: "ou_new", botAppId: "cli_new", updatedAt: 200 },
      // 旧于 base 的同事条目不该把远端最新覆盖回去
      "peer@x.com": { openId: "ou_stale", botAppId: "cli_stale", updatedAt: 1 },
      "newbie@x.com": { openId: "ou_n", botAppId: "cli_n", updatedAt: 50 },
    });

    const merged = mergeGroupMemberRegistries(base, incoming);
    expect(merged.members["me@x.com"]!.openId).toBe("ou_new");
    expect(merged.members["peer@x.com"]!.openId).toBe("ou_p");
    expect(merged.members["newbie@x.com"]!.openId).toBe("ou_n");
  });

  it("updatedAt 相同 → base 胜（结果确定、不随遍历顺序抖）", () => {
    const merged = mergeGroupMemberRegistries(
      registryOf({ "a@x.com": { openId: "ou_base", botAppId: "b", updatedAt: 7 } }),
      registryOf({ "a@x.com": { openId: "ou_in", botAppId: "i", updatedAt: 7 } }),
    );
    expect(merged.members["a@x.com"]!.openId).toBe("ou_base");
  });
});

describe("pickGroupCreationTargets", () => {
  const registry = registryOf({
    "dev@x.com": { openId: "ou_dev", botAppId: "cli_dev", updatedAt: 1 },
    "qa@x.com": { openId: "ou_qa", botAppId: "cli_qa", updatedAt: 1 },
    "nobot@x.com": { openId: "ou_nobot", botAppId: "", updatedAt: 1 },
  });

  it("命中：发起人首位 + 角色成员 open_id，bot 取各自 app_id", () => {
    const t = pickGroupCreationTargets({
      ownerOpenId: "ou_me",
      ownBotAppId: "cli_me",
      roleEmails: ["dev@x.com", "QA@x.com "],
      registry,
    });
    expect(t.userIdList).toEqual(["ou_me", "ou_dev", "ou_qa"]);
    // 本机 bot 建群自动入群、不该白占 ≤5 额度
    expect(t.botIdList).toEqual(["cli_dev", "cli_qa"]);
    expect(t.matchedEmails).toEqual(["dev@x.com", "qa@x.com"]);
    expect(t.missedEmails).toEqual([]);
  });

  it("未命中的人跳过不报错、还没配 bot 的人只进 user_id_list", () => {
    const t = pickGroupCreationTargets({
      ownerOpenId: "ou_me",
      ownBotAppId: "cli_me",
      roleEmails: ["nobot@x.com", "stranger@x.com", "不是邮箱"],
      registry,
    });
    expect(t.userIdList).toEqual(["ou_me", "ou_nobot"]);
    expect(t.botIdList).toEqual([]);
    expect(t.missedEmails).toEqual(["stranger@x.com"]);
  });

  it("空注册表 / 无角色成员 → 只有发起人（老行为）", () => {
    expect(
      pickGroupCreationTargets({
        ownerOpenId: "ou_me",
        roleEmails: ["a@x.com"],
        registry: emptyGroupMemberRegistry(),
      }).userIdList,
    ).toEqual(["ou_me"]);
    expect(
      pickGroupCreationTargets({
        ownerOpenId: "",
        roleEmails: [],
        registry: emptyGroupMemberRegistry(),
      }).userIdList,
    ).toEqual([]);
  });

  it("去重 + 飞书硬上限（user ≤50 / bot ≤5）", () => {
    const many = registryOf(
      Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `u${i}@x.com`,
          { openId: `ou_${i}`, botAppId: `cli_${i}`, updatedAt: 1 },
        ]),
      ),
    );
    const t = pickGroupCreationTargets({
      ownerOpenId: "ou_0", // 与角色成员第一条重复 → 只出现一次
      ownBotAppId: "cli_0",
      roleEmails: [
        ...Array.from({ length: 80 }, (_, i) => `u${i}@x.com`),
        "u1@x.com", // 重复邮箱
      ],
      registry: many,
    });
    expect(t.userIdList.length).toBe(50);
    expect(new Set(t.userIdList).size).toBe(50);
    expect(t.botIdList.length).toBe(5);
    expect(t.botIdList).not.toContain("cli_0");
  });
});

describe("isSameGroupMemberIdentity", () => {
  it("openId + botAppId 全同才算没变；name 漂移不算（不为展示字段推 git）", () => {
    const entry = {
      openId: "ou_a",
      botAppId: "cli_a",
      name: "旧名",
      updatedAt: 1,
    };
    expect(
      isSameGroupMemberIdentity(entry, { openId: "ou_a", botAppId: "cli_a" }),
    ).toBe(true);
    expect(
      isSameGroupMemberIdentity(entry, { openId: "ou_a", botAppId: "cli_b" }),
    ).toBe(false);
    expect(
      isSameGroupMemberIdentity(undefined, { openId: "ou_a", botAppId: "cli_a" }),
    ).toBe(false);
  });
});

// ----------------- 自动注册 -----------------

/** 注册链路的假依赖：默认「身份齐 + 表空 + 写成功」 */
const stubDeps = (over: {
  email?: string | null;
  openId?: string;
  appId?: string;
  userName?: string;
  currentRaw?: string | null;
  /** 写入口：默认记录 mutate 的产物并返回成功 */
  write?: (
    mutate: (raw: string | null) => string | null,
    message: string,
  ) => Promise<RegistryWriteResult>;
}) => {
  const warnings: string[] = [];
  const writes: Array<{ next: string | null; message: string }> = [];
  const currentRaw = over.currentRaw ?? null;
  const write =
    over.write ??
    (async (mutate, message) => {
      const next = mutate(currentRaw);
      writes.push({ next, message });
      return { ok: true, changed: next !== null && next !== currentRaw };
    });

  __setGroupRegistryDepsForTest({
    fetchLocalEmail: async () =>
      over.email === undefined ? "Edison@Example.com" : over.email,
    fetchLocalLarkIdentity: async () =>
      over.openId === "" || over.appId === ""
        ? null
        : {
            appId: over.appId ?? "cli_me",
            openId: over.openId ?? "ou_me",
            ...(over.userName ? { userName: over.userName } : {}),
          },
    fetchLocalName: async () => "陈禄江",
    readRegistryRaw: async () => currentRaw,
    writeRegistry: write,
    now: () => 1_700_000_000_000,
    warn: (m) => warnings.push(m),
  });
  return { warnings, writes };
};

describe("registerSelfToGroupRegistry", () => {
  it("首次注册：写入自己那条（email 小写当 key、带 open_id / bot app_id）", async () => {
    const { writes } = stubDeps({ userName: "陈禄江" });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "registered",
    });
    expect(writes).toHaveLength(1);
    const written = parseGroupMemberRegistry(writes[0]!.next);
    expect(written.members["edison@example.com"]).toEqual({
      openId: "ou_me",
      botAppId: "cli_me",
      name: "陈禄江",
      updatedAt: 1_700_000_000_000,
    });
    expect(writes[0]!.message).toContain("edison@example.com");
  });

  it("幂等：本机身份没变 → 压根不进写流程（不 push、不产生空提交）", async () => {
    const existing = serializeGroupMemberRegistry(
      registryOf({
        "edison@example.com": {
          openId: "ou_me",
          botAppId: "cli_me",
          name: "陈禄江",
          updatedAt: 1,
        },
      }),
    );
    const writeSpy = vi.fn();
    const { writes } = stubDeps({ currentRaw: existing, write: writeSpy });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "unchanged",
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("数据分支还没人建（读到 null）→ 当空表、照常走写入口把分支建出来", async () => {
    const { writes } = stubDeps({ currentRaw: null });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "registered",
    });
    // mutate 收到 null（分支不存在）也要能产出完整内容，写入口据此建孤儿分支
    const written = parseGroupMemberRegistry(writes[0]!.next);
    expect(Object.keys(written.members)).toEqual(["edison@example.com"]);
  });

  it("幂等第二道闸：本地读到的分支内容陈旧、fetch 后发现已注册 → mutate 返 null 不 commit", async () => {
    // 本地看不到自己（陈旧），远端其实已经有了同一份身份
    const remote = serializeGroupMemberRegistry(
      registryOf({
        "edison@example.com": {
          openId: "ou_me",
          botAppId: "cli_me",
          updatedAt: 1,
        },
      }),
    );
    let mutated: string | null | undefined;
    stubDeps({
      currentRaw: null,
      write: async (mutate) => {
        mutated = mutate(remote);
        return { ok: true, changed: mutated !== null };
      },
    });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "unchanged",
    });
    expect(mutated).toBeNull();
  });

  it("并发合并：mutate 拿到的是远端最新 → 只动自己那条、同事的原样保留", async () => {
    // 本地克隆里只有自己（旧身份）；写的时候远端已被同事写入了新条目
    const localRaw = serializeGroupMemberRegistry(
      registryOf({
        "edison@example.com": {
          openId: "ou_old",
          botAppId: "cli_old",
          updatedAt: 1,
        },
      }),
    );
    const remoteRaw = serializeGroupMemberRegistry(
      registryOf({
        "edison@example.com": {
          openId: "ou_old",
          botAppId: "cli_old",
          updatedAt: 1,
        },
        "peer@x.com": {
          openId: "ou_peer",
          botAppId: "cli_peer",
          name: "同事",
          updatedAt: 1_699_999_999_999,
        },
      }),
    );
    let merged: string | null | undefined;
    stubDeps({
      currentRaw: localRaw,
      write: async (mutate) => {
        merged = mutate(remoteRaw);
        return { ok: true, changed: true };
      },
    });

    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "registered",
    });
    const reg = parseGroupMemberRegistry(merged);
    // 自己那条被刷新
    expect(reg.members["edison@example.com"]).toMatchObject({
      openId: "ou_me",
      botAppId: "cli_me",
      updatedAt: 1_700_000_000_000,
    });
    // 同事那条一个字都没动（新者胜、我们只带自己一条 incoming）
    expect(reg.members["peer@x.com"]).toMatchObject({
      openId: "ou_peer",
      botAppId: "cli_peer",
      name: "同事",
    });
  });

  it("无写权限（保护分支拒推）→ 只 warn，不抛、不 toast", async () => {
    const { warnings } = stubDeps({
      write: async () => ({
        ok: false,
        changed: false,
        error: "git push 失败：You are not allowed to push code to protected branches",
      }),
    });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "failed",
      error: expect.stringContaining("protected") as unknown as string,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("自动注册失败");
  });

  it("写入口自己抛异常 → 兜住返 failed（绝不冒泡到建群链路）", async () => {
    const { warnings } = stubDeps({
      write: async () => {
        throw new Error("网络不可达");
      },
    });
    await expect(registerSelfToGroupRegistry()).resolves.toMatchObject({
      status: "failed",
    });
    expect(warnings.some((w) => w.includes("网络不可达"))).toBe(true);
  });

  it("meegle 拿不到邮箱 → skipped no_email（不写半条脏记录）", async () => {
    const writeSpy = vi.fn();
    stubDeps({ email: null, write: writeSpy });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "skipped",
      reason: "no_email",
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("lark-cli user 身份没登录 → skipped no_lark_identity", async () => {
    const writeSpy = vi.fn();
    stubDeps({ openId: "", write: writeSpy });
    await expect(registerSelfToGroupRegistry()).resolves.toEqual({
      status: "skipped",
      reason: "no_lark_identity",
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("scheduleSelfRegistration", () => {
  it("成功一次后本进程不再重复跑（热路径零开销）", async () => {
    const readSpy = vi.fn().mockResolvedValue(null);
    __setGroupRegistryDepsForTest({
      fetchLocalEmail: async () => "edison@example.com",
      fetchLocalLarkIdentity: async () => ({
        appId: "cli_me",
        openId: "ou_me",
      }),
      fetchLocalName: async () => null,
      readRegistryRaw: readSpy,
      writeRegistry: async () => ({ ok: true, changed: true }),
      now: () => 1,
      warn: () => {},
    });

    scheduleSelfRegistration();
    scheduleSelfRegistration(); // 在飞时的重入必须被挡掉
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));
    scheduleSelfRegistration();
    await new Promise((r) => setTimeout(r, 10));
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it("失败后退避：短时间内不重复打 git", async () => {
    const readSpy = vi.fn().mockResolvedValue(null);
    __setGroupRegistryDepsForTest({
      fetchLocalEmail: async () => "edison@example.com",
      fetchLocalLarkIdentity: async () => ({
        appId: "cli_me",
        openId: "ou_me",
      }),
      fetchLocalName: async () => null,
      readRegistryRaw: readSpy,
      writeRegistry: async () => ({ ok: false, changed: false, error: "无权限" }),
      now: () => 1,
      warn: () => {},
    });

    scheduleSelfRegistration();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));
    scheduleSelfRegistration();
    await new Promise((r) => setTimeout(r, 10));
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

// ----------------- meegle 侧解析（注册表的两个数据源） -----------------

describe("parseWorkitemRoleMembers", () => {
  it("work_item_attribute.role_members 真实形状：按角色拍平、带 email / user_key", () => {
    const members = parseWorkitemRoleMembers({
      work_item_attribute: {
        role_members: [
          {
            role: "开发",
            members: [
              { key: "713592", name: "陈禄江", email: "edison@example.com" },
              { key: "713593", name: "同事", email: "peer@example.com" },
            ],
          },
          {
            role: "测试",
            owners: [{ key: "713594", name: "QA", email: "qa@example.com" }],
          },
        ],
      },
    });
    expect(members.map((m) => m.email)).toEqual([
      "edison@example.com",
      "peer@example.com",
      "qa@example.com",
    ]);
    expect(members[0]).toMatchObject({ role: "开发", userKey: "713592" });
    expect(members[2]!.role).toBe("测试");
  });

  it("role_owners 别名 + 扁平形态（角色条目本身就是一个人）也能解析", () => {
    const members = parseWorkitemRoleMembers({
      data: {
        role_owners: [{ key: "1", name: "产品", email: "pm@example.com" }],
      },
    });
    expect(members).toEqual([
      { name: "产品", email: "pm@example.com", userKey: "1" },
    ]);
  });

  it("没有角色字段 / 空返回 → 空数组（不抛）", () => {
    expect(parseWorkitemRoleMembers({ work_item_fields: [] })).toEqual([]);
    expect(parseWorkitemRoleMembers(null)).toEqual([]);
    expect(parseWorkitemRoleMembers("字符串")).toEqual([]);
  });
});

describe("parseUserSearchEmail", () => {
  it("按 user_key 命中；各种包裹层都兼容", () => {
    expect(
      parseUserSearchEmail(
        { data: [{ user_key: "a", email: "a@x.com" }, { user_key: "b", email: "b@x.com" }] },
        "b",
      ),
    ).toBe("b@x.com");
    expect(
      parseUserSearchEmail([{ key: "a", email: "a@x.com" }], "a"),
    ).toBe("a@x.com");
  });

  it("只有一条结果时不强求 key 匹配；多条且都不匹配 → undefined", () => {
    expect(parseUserSearchEmail({ list: [{ email: "solo@x.com" }] })).toBe(
      "solo@x.com",
    );
    expect(
      parseUserSearchEmail(
        { list: [{ user_key: "x", email: "x@x.com" }, { user_key: "y", email: "y@x.com" }] },
        "z",
      ),
    ).toBeUndefined();
    expect(parseUserSearchEmail(null)).toBeUndefined();
  });
});
