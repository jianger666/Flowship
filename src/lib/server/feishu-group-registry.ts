/**
 * 需求群成员自动注册表（团队库共享单文件、替代已删的手工 members.json）
 *
 * # 为什么需要它
 *
 * 建群时想一次带齐「工作项相关角色的人 + 他们各自的 bot」，但免审 scope 下
 * **拿不到同事的 open_id**（实测结论见 docs/feishu-group-collab.md「id 换算实测表」）：
 * meegle 侧能给 email / user_key / lark_user_id / union_id，这四个换我们自建 app 可用的
 * open_id 全部失败（跨开发商 / 缺 contact scope / 通讯录搜索无权限）。
 *
 * 唯一可行的桥：**每人的 Flowship 自动把自己的身份写进团队共享库**，建群时按 email
 * 反查。email 是唯一两侧都有的稳定键——meegle 角色成员给 email，本机也能从 meegle
 * 拿到自己的 email（**必须同源**，否则 key 空间对不上）。
 *
 * # 形态
 *
 * - 位置：团队库的**专用数据分支** `members` 上的 `group-members.json`
 *   （`team-library.TEAM_LIBRARY_DATA_BRANCH`、**单个文件**，不是一人一文件——
 *   email 当 key 天然去重、每个人只覆盖自己那条）
 * - ⚠️ **不放 `main`**：main 受保护、developer 直推被拒 = 自动注册永远失败。
 *   `members` 分支必须**不开保护**（见 docs/feishu-group-collab.md）
 * - 注册：用户零操作。用到群协作时后台自动跑（见 `scheduleSelfRegistration`）
 * - 幂等：本机身份（email / openId / botAppId）没变就不写、不 push、不产生空提交
 * - 并发：单文件多人写 → 每轮先 fetch 分支再按 email 逐条 merge（updatedAt 新者胜）、
 *   push 撞 non-fast-forward 就重来一轮
 * - **静默失败**：没写权限 / push 被拒 / 网络挂 → 只 warn，绝不 toast、绝不阻塞主流程，
 *   也不自动开 MR（注册不上就退回建群「只拉发起人」的老行为）
 *
 * # 依赖方向
 *
 * 读写都要动 git（读 = `git show origin/members:group-members.json`），所以两条路径
 * 都**动态** import `team-library`——建群链路很热，不能把那张重依赖图静态拉进来。
 * git 管道本身全在 `team-library` 里，这里一条 git 命令都不自己拼。
 */

import { fetchMyEmail, fetchMyIdentity } from "./meegle-cli";
import { getLarkLocalIdentity } from "./feishu-bridge/lark-api";

// ----------------- 类型 / 常量 -----------------

/** 注册表文件名（团队库数据分支的仓根） */
export const GROUP_MEMBERS_FILE = "group-members.json";

/** 结构版本（将来改形状时用来分流；当前只有 1） */
export const GROUP_MEMBERS_VERSION = 1;

/** 建群 `user_id_list` 上限（飞书硬约束） */
export const MAX_GROUP_USER_IDS = 50;

/** 建群 `bot_id_list` 上限（飞书硬约束） */
export const MAX_GROUP_BOT_IDS = 5;

/** 注册表里的一条：某人的 IM 身份 + 他自己那台 Flowship 的 bot */
export interface GroupMemberEntry {
  /** 飞书 IM open_id —— 建群 `user_id_list` 用 */
  openId: string;
  /** 本人 Flowship 自建应用 app_id —— 建群 `bot_id_list` 用（没配 bot 时可为空串） */
  botAppId: string;
  /** 展示名（排障用、不参与任何匹配） */
  name?: string;
  /** 本条写入时间（ms）——多人并发写同一文件时「新者胜」的判据 */
  updatedAt: number;
}

export interface GroupMemberRegistry {
  version: number;
  /** key = 规范化后的小写邮箱（与 meegle 角色成员的 email 同一体系） */
  members: Record<string, GroupMemberEntry>;
}

/** 本机身份（注册表里自己那一条的原料） */
export interface LocalGroupIdentity {
  /** meegle 侧邮箱（注册表 key） */
  email: string;
  /** 飞书 IM open_id */
  openId: string;
  /** 本机 Flowship 自建应用 app_id */
  botAppId: string;
  name?: string;
}

export const emptyGroupMemberRegistry = (): GroupMemberRegistry => ({
  version: GROUP_MEMBERS_VERSION,
  members: {},
});

// ----------------- 纯函数（单测友好） -----------------

/**
 * 邮箱规范化：trim + 小写；**不像邮箱的一律返空串**。
 * 角色成员列表里偶尔混进姓名 / user_key，拿它们当 key 会污染整张表。
 */
export const normalizeMemberEmail = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
};

/**
 * 解析注册表文件原文（不存在 / 坏 JSON / 结构不对 → 空表）。
 * 坏一条不牵连整表：单条缺 openId（建群拉不了人）直接跳过。
 */
export const parseGroupMemberRegistry = (
  raw: string | null | undefined,
): GroupMemberRegistry => {
  if (typeof raw !== "string" || !raw.trim()) return emptyGroupMemberRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyGroupMemberRegistry();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyGroupMemberRegistry();
  }
  const root = parsed as Record<string, unknown>;
  const membersRaw = root.members;
  if (!membersRaw || typeof membersRaw !== "object" || Array.isArray(membersRaw)) {
    return emptyGroupMemberRegistry();
  }

  const members: Record<string, GroupMemberEntry> = {};
  for (const [key, value] of Object.entries(
    membersRaw as Record<string, unknown>,
  )) {
    const email = normalizeMemberEmail(key);
    if (!email) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const e = value as Record<string, unknown>;
    const openId = typeof e.openId === "string" ? e.openId.trim() : "";
    // openId 是这条记录的存在意义（建群拉人）；botAppId 允许空（同事还没配 bot）
    if (!openId) continue;
    const botAppId = typeof e.botAppId === "string" ? e.botAppId.trim() : "";
    const name =
      typeof e.name === "string" && e.name.trim() ? e.name.trim() : undefined;
    const updatedAt =
      typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt)
        ? e.updatedAt
        : 0;
    // 同一邮箱大小写不同写了两条（历史脏数据）→ 新者胜
    const prev = members[email];
    if (prev && prev.updatedAt >= updatedAt) continue;
    members[email] = {
      openId,
      botAppId,
      ...(name ? { name } : {}),
      updatedAt,
    };
  }

  const version =
    typeof root.version === "number" && Number.isFinite(root.version)
      ? root.version
      : GROUP_MEMBERS_VERSION;
  return { version, members };
};

/**
 * 序列化：email 升序 + 2 空格缩进 + 尾换行。
 * 顺序固定 = 多人并发写时 diff 最小、也不会因为遍历顺序抖出假变更。
 */
export const serializeGroupMemberRegistry = (
  reg: GroupMemberRegistry,
): string => {
  const members: Record<string, GroupMemberEntry> = {};
  for (const email of Object.keys(reg.members).sort()) {
    const e = reg.members[email]!;
    members[email] = {
      openId: e.openId,
      botAppId: e.botAppId,
      ...(e.name ? { name: e.name } : {}),
      updatedAt: e.updatedAt,
    };
  }
  return `${JSON.stringify(
    { version: reg.version || GROUP_MEMBERS_VERSION, members },
    null,
    2,
  )}\n`;
};

/**
 * 按 email 逐条合并：**updatedAt 新者胜**；相等保留 base
 *（结果确定、不随遍历顺序抖）。
 *
 * 用在写冲突重试里：每轮拿到的 base 都是刚 fetch+reset 下来的远端最新，
 * incoming 只有自己那一条 —— 天然不会覆盖别人的更新。
 */
export const mergeGroupMemberRegistries = (
  base: GroupMemberRegistry,
  incoming: GroupMemberRegistry,
): GroupMemberRegistry => {
  const members: Record<string, GroupMemberEntry> = { ...base.members };
  for (const [email, entry] of Object.entries(incoming.members)) {
    const prev = members[email];
    if (!prev || entry.updatedAt > prev.updatedAt) members[email] = entry;
  }
  return {
    version: Math.max(
      base.version || GROUP_MEMBERS_VERSION,
      incoming.version || GROUP_MEMBERS_VERSION,
    ),
    members,
  };
};

/** 建群时要带的人 / bot（`pickGroupCreationTargets` 的产出） */
export interface GroupCreationTargets {
  /** 建群 `user_id_list`（发起人本人恒在首位、去重、≤50） */
  userIdList: string[];
  /** 建群 `bot_id_list`（不含本机 bot——它建群自动入群、别白占 ≤5 额度） */
  botIdList: string[];
  /** 命中注册表的邮箱（诊断 / 单测断言） */
  matchedEmails: string[];
  /** 未命中的邮箱（还没用过 Flowship 群功能的人、跳过不报错） */
  missedEmails: string[];
}

/**
 * 角色成员邮箱清单 → 建群载荷（纯函数）。
 *
 * - 发起人本人恒在 `user_id_list` 首位：bot 建群时只有 bot 自己入群，
 *   不带人的话建群人自己都看不见这个群
 * - 本机 bot 从 `bot_id_list` 里排除（建群者的 bot 自动入群）
 * - 未命中的人直接跳过——「同事还没用过 Flowship 群功能」是常态、不是错误
 */
export const pickGroupCreationTargets = (input: {
  ownerOpenId?: string;
  /** 本机 bot 的 app_id（用于把自己排除出 bot_id_list） */
  ownBotAppId?: string;
  roleEmails: readonly string[];
  registry: GroupMemberRegistry;
}): GroupCreationTargets => {
  const userIdList: string[] = [];
  const botIdList: string[] = [];
  const matchedEmails: string[] = [];
  const missedEmails: string[] = [];
  const seenUser = new Set<string>();
  const seenBot = new Set<string>();
  const seenEmail = new Set<string>();

  const owner = (input.ownerOpenId ?? "").trim();
  if (owner) {
    userIdList.push(owner);
    seenUser.add(owner);
  }
  const ownBot = (input.ownBotAppId ?? "").trim();
  if (ownBot) seenBot.add(ownBot);

  for (const raw of input.roleEmails) {
    const email = normalizeMemberEmail(raw);
    if (!email || seenEmail.has(email)) continue;
    seenEmail.add(email);

    const hit = input.registry.members[email];
    if (!hit) {
      missedEmails.push(email);
      continue;
    }
    matchedEmails.push(email);

    const openId = hit.openId.trim();
    if (openId && !seenUser.has(openId) && userIdList.length < MAX_GROUP_USER_IDS) {
      seenUser.add(openId);
      userIdList.push(openId);
    }
    // 角色顺序即优先级：先到的先占 ≤5 的 bot 额度
    const botAppId = hit.botAppId.trim();
    if (botAppId && !seenBot.has(botAppId) && botIdList.length < MAX_GROUP_BOT_IDS) {
      seenBot.add(botAppId);
      botIdList.push(botAppId);
    }
  }

  return { userIdList, botIdList, matchedEmails, missedEmails };
};

/** 本机身份是否与表里已有那条一致（一致就不写、不 push、不产生空提交） */
export const isSameGroupMemberIdentity = (
  entry: GroupMemberEntry | undefined,
  identity: Pick<LocalGroupIdentity, "openId" | "botAppId">,
): boolean =>
  !!entry &&
  entry.openId === identity.openId &&
  entry.botAppId === identity.botAppId;

// ----------------- 可注入依赖（单测 mock 外部调用） -----------------

/** 写回团队库的结果（对齐 team-library.writeTeamLibraryBranchFile） */
export interface RegistryWriteResult {
  ok: boolean;
  /** 真产生了 commit + push（false = 内容没变、幂等跳过） */
  changed: boolean;
  error?: string;
}

export interface GroupRegistryDeps {
  /** 本机 meegle 侧邮箱（注册表 key、必须与角色成员的 email 同源） */
  fetchLocalEmail: () => Promise<string | null>;
  /** 本机 lark-cli 身份：bot app_id + 本人 open_id + 姓名 */
  fetchLocalLarkIdentity: () => Promise<{
    appId: string;
    openId: string;
    userName?: string;
  } | null>;
  /** meegle 姓名（lark 侧没给名字时兜底） */
  fetchLocalName: () => Promise<string | null>;
  /** 读数据分支上的注册表原文（分支 / 文件不存在返 null） */
  readRegistryRaw: () => Promise<string | null>;
  /**
   * 写回数据分支：mutate 收到的是**刚 fetch 下来**的分支内容，返回新内容；
   * 返 null = 无需改动。冲突重试由实现方负责
   *（见 team-library.writeTeamLibraryBranchFile）。
   */
  writeRegistry: (
    mutate: (currentRaw: string | null) => string | null,
    message: string,
  ) => Promise<RegistryWriteResult>;
  now: () => number;
  warn: (msg: string) => void;
}

const defaultDeps = (): GroupRegistryDeps => ({
  fetchLocalEmail: () => fetchMyEmail(),
  fetchLocalLarkIdentity: () => getLarkLocalIdentity(),
  fetchLocalName: async () => (await fetchMyIdentity())?.name ?? null,
  // 读写都动态 import team-library：那张依赖图很重，别静态挂到建群链路上
  readRegistryRaw: async () => {
    const { readTeamLibraryBranchFile } = await import("./team-library");
    return readTeamLibraryBranchFile({ relPath: GROUP_MEMBERS_FILE });
  },
  writeRegistry: async (mutate, message) => {
    const { writeTeamLibraryBranchFile } = await import("./team-library");
    const r = await writeTeamLibraryBranchFile({
      relPath: GROUP_MEMBERS_FILE,
      mutate,
      message,
    });
    return r.ok
      ? { ok: true, changed: r.changed }
      : { ok: false, changed: false, error: r.error };
  },
  now: () => Date.now(),
  warn: (msg) => console.warn(`[feishu-group-registry] ${msg}`),
});

let depsOverride: Partial<GroupRegistryDeps> | null = null;

const getDeps = (): GroupRegistryDeps =>
  depsOverride ? { ...defaultDeps(), ...depsOverride } : defaultDeps();

/** 单测替换依赖；传 null 恢复默认 */
export const __setGroupRegistryDepsForTest = (
  partial: Partial<GroupRegistryDeps> | null,
): void => {
  depsOverride = partial;
};

// ----------------- 读（建群时消费） -----------------

/**
 * 读数据分支上的注册表（`git show origin/members:group-members.json`、只读对象库）。
 * 新鲜度靠 `syncTeamLibrary`——它每轮顺带 fetch 这个分支；这里**不主动拉网**，
 * 建群链路不能为了一张增强用的表去等 git 网络。
 */
export const readGroupMemberRegistry = async (): Promise<GroupMemberRegistry> =>
  parseGroupMemberRegistry(await getDeps().readRegistryRaw());

// ----------------- 写（本机自动注册） -----------------

export type SelfRegistrationResult =
  | { status: "registered" }
  | { status: "unchanged" }
  | { status: "skipped"; reason: "no_email" | "no_lark_identity" }
  | { status: "failed"; error: string };

/**
 * 解析本机身份：email 来自 **meegle**（必须与工作项角色成员同源）、
 * open_id / bot app_id / 姓名来自 **lark-cli `auth status`**（免审、纯本地凭据读取）。
 *
 * 任一必需项拿不到就返 null——注册是增强路径，不齐就不写半条脏记录。
 */
export const resolveLocalGroupIdentity =
  async (): Promise<LocalGroupIdentity | null> => {
    const deps = getDeps();
    const [email, lark] = await Promise.all([
      deps.fetchLocalEmail().catch(() => null),
      deps.fetchLocalLarkIdentity().catch(() => null),
    ]);
    const normalizedEmail = normalizeMemberEmail(email);
    if (!normalizedEmail) return null;
    const openId = lark?.openId?.trim() ?? "";
    const botAppId = lark?.appId?.trim() ?? "";
    if (!openId || !botAppId) return null;

    let name = lark?.userName?.trim() ?? "";
    if (!name) name = (await deps.fetchLocalName().catch(() => null))?.trim() ?? "";
    return {
      email: normalizedEmail,
      openId,
      botAppId,
      ...(name ? { name } : {}),
    };
  };

/**
 * 把本机身份注册进团队共享库（幂等、**绝不抛**）。
 *
 * 幂等口径：表里已有同 email 且 `openId` / `botAppId` 全同 → 直接返回 unchanged，
 * 不造提交不 push。`name` 漂移不触发写——为一个纯展示字段推一次 git 不划算。
 *
 * 两道幂等闸：先按上次 fetch 下来的 `origin/members` 快查一次（省掉一整轮 git 网络），
 * 真进写流程后在 mutate 里对**刚 fetch 的最新分支内容**再判一次（别人可能已经替你
 * 写过 / 你自己在另一个实例里写过）——关死「空提交」窗口。
 */
export const registerSelfToGroupRegistry =
  async (): Promise<SelfRegistrationResult> => {
    const deps = getDeps();
    try {
      const identity = await resolveLocalGroupIdentity();
      if (!identity) {
        // 分不清是缺 email 还是缺 lark 身份时按 email 归类；两者都只是「还没登录齐」
        const email = normalizeMemberEmail(
          await deps.fetchLocalEmail().catch(() => null),
        );
        return {
          status: "skipped",
          reason: email ? "no_lark_identity" : "no_email",
        };
      }

      // 闸一：读上次 fetch 下来的分支内容快查（绝大多数调用停在这里、零 git 网络）
      const local = parseGroupMemberRegistry(await deps.readRegistryRaw());
      if (isSameGroupMemberIdentity(local.members[identity.email], identity)) {
        return { status: "unchanged" };
      }

      const write = await deps.writeRegistry((currentRaw) => {
        const remote = parseGroupMemberRegistry(currentRaw);
        // 闸二：fetch 到最新分支内容后再判一次幂等（关死空提交窗口）
        if (isSameGroupMemberIdentity(remote.members[identity.email], identity)) {
          return null;
        }
        const mine: GroupMemberRegistry = {
          version: GROUP_MEMBERS_VERSION,
          members: {
            [identity.email]: {
              openId: identity.openId,
              botAppId: identity.botAppId,
              ...(identity.name ? { name: identity.name } : {}),
              updatedAt: deps.now(),
            },
          },
        };
        // 只动自己那条：别人的更新原样保留（merge 语义 = 按 email 逐条、新者胜）
        return serializeGroupMemberRegistry(
          mergeGroupMemberRegistries(remote, mine),
        );
      }, `chore(group-members): 注册 ${identity.email} from Flowship`);

      if (!write.ok) {
        // 静默失败：members 分支被开了保护 / 没推送权限 / 网络挂 → 只留日志，
        // 不 toast、不阻塞、不自动开 MR。建群退回「只拉发起人」的老行为。
        const msg = write.error ?? "写共享库失败";
        deps.warn(`自动注册失败（不影响群协作、下次再试）：${msg}`);
        return { status: "failed", error: msg };
      }
      return write.changed ? { status: "registered" } : { status: "unchanged" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.warn(`自动注册异常（已忽略）：${msg}`);
      return { status: "failed", error: msg };
    }
  };

// ----------------- 后台触发（用户零操作） -----------------

/** 失败后的重试间隔——CLI 没登录 / 没配 token 时别每次群操作都打一轮 git */
const SELF_REGISTER_RETRY_MS = 30 * 60 * 1000;

const SELF_REGISTER_STATE_KEY = "__flowshipGroupRegistrySelfV1__";

type SelfRegisterState = {
  /** 本进程已确认注册到位（成功 / 幂等无变化）——之后不再跑 */
  done: boolean;
  /** 有一轮在飞（防并发重入） */
  inFlight: boolean;
  /** 上次尝试时间（失败退避用） */
  lastAttemptAt: number;
};

const getSelfRegisterState = (): SelfRegisterState => {
  const g = globalThis as unknown as Record<
    string,
    SelfRegisterState | undefined
  >;
  if (!g[SELF_REGISTER_STATE_KEY]) {
    g[SELF_REGISTER_STATE_KEY] = {
      done: false,
      inFlight: false,
      lastAttemptAt: 0,
    };
  }
  return g[SELF_REGISTER_STATE_KEY]!;
};

/** 单测清状态（否则同文件多个用例互相污染） */
export const __resetSelfRegistrationStateForTest = (): void => {
  const st = getSelfRegisterState();
  st.done = false;
  st.inFlight = false;
  st.lastAttemptAt = 0;
};

/**
 * 后台自动注册（**同步返回、零 IO 快路径**）。
 *
 * 挂在群协作的自然入口（`ensureRequirementGroup` / `getBoundGroupChatId`）——
 * 用到群功能的人才注册，不新增任何用户可见步骤。热路径会被高频调用，
 * 所以快路径只有布尔判断 + 一次时间戳比较。
 *
 * 单测默认不跑（会真 spawn CLI + 打 git 网络）；测试要验注册逻辑请直接调
 * `registerSelfToGroupRegistry` 并用 `__setGroupRegistryDepsForTest` 注入假依赖。
 */
export const scheduleSelfRegistration = (): void => {
  if (process.env.VITEST && !depsOverride) return;
  const st = getSelfRegisterState();
  if (st.done || st.inFlight) return;
  if (
    st.lastAttemptAt > 0 &&
    Date.now() - st.lastAttemptAt < SELF_REGISTER_RETRY_MS
  ) {
    return;
  }
  st.inFlight = true;
  st.lastAttemptAt = Date.now();
  void registerSelfToGroupRegistry()
    .then((r) => {
      // skipped（CLI 还没登录齐）不标 done——登录上之后下一轮就能补注册
      if (r.status === "registered" || r.status === "unchanged") st.done = true;
    })
    .catch(() => {
      /* registerSelfToGroupRegistry 内部已兜底，这里只防万一 */
    })
    .finally(() => {
      st.inFlight = false;
    });
};
