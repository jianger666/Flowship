/**
 * `git status --porcelain=v2 -z` 的纯解析（WIP 快照守卫用；零 IO、可在任何平台单测）。
 *
 * 为什么不用 v1：v1 的 ` M vendor/sub` 分不清「子模块指针变了」和「子模块里有未提交改动」。
 * 后者进不了父仓的 tree（只存一个 gitlink 指针），WIP 快照 `add -A` + `write-tree` 之后树与 HEAD 相同、
 * 被判 clean → 整个 worktree 目录被删，子模块里的改动永久丢失（第三轮 review D2b-15 / F1-05，实测复现）。
 * v2 的 `<sub>` 字段是 `N...`（非子模块）或 `S<c><m><u>`：c=指针变了、m=子模块里有 tracked 改动、u=子模块里有未跟踪文件。
 * 其中 m / u 才是「快照存不下」的改动。c（指针变了）父仓 tree 里有 gitlink 记录，但那只是个 sha：若这个提交只存在于
 * 子模块自己的 gitdir（本地提交、没推送）——删 worktree 会连子模块 gitdir 一起删，提交就不可达了（第四轮 Q3-03）。
 * 所以 c 单独收进 movedSubmodules，由调用方再去子模块里查「HEAD 是否已在某个远端上」。
 *
 * 记录格式（-z：以 NUL 分隔、路径不转义）：
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>   ← 改名 / 复制，多一个 NUL 字段
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>                   ← 未合并
 *   ? <path>                                                                  ← 未跟踪
 *   ! <path>                                                                  ← 被忽略（默认不输出）
 */

export interface WorktreeStatusSummary {
  /** 有效记录数（不含表头 / 被忽略项）；0 = 干净 */
  total: number;
  /** 未合并（merge / rebase 冲突）的路径 */
  unmerged: string[];
  /** 子模块「里面」有未提交改动（tracked 改动或未跟踪文件）的路径 */
  dirtySubmodules: string[];
  /** 子模块「指针」变了（HEAD 不等于父仓记录的提交）的路径——提交可能只在子模块本地，调用方需进一步核实可恢复性 */
  movedSubmodules: string[];
  /** 未跟踪的目录条目（原样带尾部 `/`）——调用方再探测里面是不是嵌套 git 仓 */
  untrackedDirs: string[];
}

/** 取前 n 个以单空格分隔的字段，其余原样作为 path（路径里的空格不会被拆） */
const splitLeading = (rec: string, n: number): { fields: string[]; path: string } | null => {
  const fields: string[] = [];
  let from = 0;
  for (let i = 0; i < n; i++) {
    const sp = rec.indexOf(" ", from);
    if (sp < 0) return null;
    fields.push(rec.slice(from, sp));
    from = sp + 1;
  }
  return { fields, path: rec.slice(from) };
};

const SUBMODULE_FIELD = /^S([C.])([M.])([U.])$/;

export const parseWorktreeStatusV2 = (raw: string): WorktreeStatusSummary => {
  const out: WorktreeStatusSummary = {
    total: 0,
    unmerged: [],
    dirtySubmodules: [],
    movedSubmodules: [],
    untrackedDirs: [],
  };
  if (!raw) return out;

  const recs = raw.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const kind = rec[0];

    if (kind === "1" || kind === "2") {
      // `1`：8 个前导字段后是 path；`2`：9 个（多一个 Xscore），且后面再跟一个 NUL 分隔的原路径字段
      const parsed = splitLeading(rec, kind === "1" ? 8 : 9);
      if (kind === "2") i += 1; // 吞掉 origPath
      if (!parsed) continue;
      out.total += 1;
      const m = SUBMODULE_FIELD.exec(parsed.fields[2] ?? "");
      if (m && (m[2] === "M" || m[3] === "U")) out.dirtySubmodules.push(parsed.path);
      if (m && m[1] === "C") out.movedSubmodules.push(parsed.path);
    } else if (kind === "u") {
      const parsed = splitLeading(rec, 10);
      if (!parsed) continue;
      out.total += 1;
      out.unmerged.push(parsed.path);
    } else if (kind === "?") {
      const p = rec.slice(2);
      if (!p) continue;
      out.total += 1;
      if (p.endsWith("/")) out.untrackedDirs.push(p);
    }
    // `!` / `#` / 其它：忽略
  }
  return out;
};
