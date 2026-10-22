/**
 * 回退清理「未跟踪文件」时的目标树别名守卫（第三轮 review R1-01；纯函数、零 IO）。
 *
 * 为什么要它：`restoreRepoTree` 只删「安全快照里有、目标树里没有」的路径。在大小写不敏感的盘上
 * （macOS APFS 默认 / Windows NTFS），这类路径可能与目标树里的文件是**同一个物理文件**
 * （目标点 `Components/a.ts`、回合内改名成 `components/a.ts`）——unlink 它就等于删了刚恢复的目标版本。
 *
 * 第二轮用 `git ls-files -o` 当裁判，但 git 的判断依赖 `core.ignorecase`：`false` 的仓建在大小写不敏感的盘上时，
 * index 把它们当两个文件、`ls-files -o` 照样列出，守卫失效。所以这里**不信 index 的大小写语义**，
 * 直接把目标树的全部路径 NFC + 小写折叠成集合，待删路径折叠后命中就绝不删。
 *
 * 取舍：在真正大小写敏感的盘上，同名异大小写是两个真文件，这条规则会让 AI 新建的那一个被多留下来——
 * 它在安全快照里、随时能找回；多留一个文件远好过删错一个。
 */

/**
 * 折叠键：NFC（macOS 老盘 / 拷贝来的文件名常是 NFD）+ 完整大小写折叠。
 *
 * 只 `toLowerCase()` 比 APFS 窄（第四轮 Q3-12，24 对名字 × 真 APFS 实测保护不足 7 对）：APFS 用的是「完整」折叠，
 * ß ~ SS ~ ss、ﬁ ~ fi ~ FI、ς ~ σ、ΑΣ ~ ασ、ßß ~ SSSS 在盘上是同一个文件，纯小写化却给出不同的键 → 别名守卫漏过 →
 * 回退时 unlink 把刚恢复的目标文件删了。先 `toUpperCase()`（ß→SS、ﬁ→FI、ς→Σ 都展开 / 归一）再 `toLowerCase()`
 * 就覆盖这些；末尾再 NFC 一次（大写展开可能产生组合序列）。过度折叠只会「多留文件」（保守），不会删错。
 */
export const foldRepoPath = (p: string): string => foldOnce(foldOnce(p)).normalize("NFC");

/**
 * 折叠迭代两轮（第五轮复审）：单轮 `NFC → upper → lower` 对 `ẞ`（U+1E9E 大写 ß）会给出 `ß`，而 `ß` 自己给出 `ss`，
 * 两者在 APFS 上是同一个文件（`ẞ ~ ß`），单轮键却不同——这对原本旧写法（纯 `toLowerCase`）是对的、被第四轮的新写法弄坏。
 * 再折叠一轮就收敛（复审在真 APFS 上扫 BMP 全部变体对：保护不足 333 → 1 → 0，且没有新缺口）。
 */
const foldOnce = (s: string): string => s.normalize("NFC").toUpperCase().toLowerCase();

/** 目标树路径集合（折叠后）。入参是 `git ls-tree -r --name-only -z <tree>` 的 NUL 分隔输出 */
export const buildTargetFoldSet = (lsTreeZ: string): Set<string> =>
  new Set(lsTreeZ.split("\0").filter(Boolean).map(foldRepoPath));

/** 待删路径与目标树任一路径仅大小写 / 规范化不同 → true（调用方一律不删） */
export const isTargetTreeAlias = (rel: string, folded: ReadonlySet<string>): boolean =>
  folded.has(foldRepoPath(rel));
