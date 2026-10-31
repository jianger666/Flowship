/**
 * 「用系统默认应用打开」之前读一次盘（R14 S1 · Q14-01）
 *
 * `buildOpenPathPlan`（`local-file-os.ts`）是纯函数，只能看路径字符串，扩展名黑名单有两个洞：
 *  ① 无扩展名（或扩展名无害）但带可执行位的文件——macOS 的 `open` 会在终端里运行它；
 *  ② 名字无害的符号链接（`notes.txt → Foo.app`、`readme → /bin/ls`）——黑名单只看链接自己的名字，系统打开时却会走到目标。
 * 这里读出两件事实交给纯函数：解开符号链接后的真实路径、真实路径是不是「带可执行位的普通文件」。
 *
 * 取舍（都是有意的）：
 *  - **Windows 不读盘**：没有可执行位；符号链接按链接自己的名字 / 扩展名关联，不会因为目标是 .exe 就被执行；
 *    而且 realpath 会让本进程顺着符号链接去连它指向的 UNC 共享（SMB / NTLM 外泄，正是 `unc-path.ts` 要防的）。
 *  - **读不到就不给事实**（不存在 / 无权限 / 路径含 NUL / 符号链接成环）：纯函数按原路径走原来的判断，
 *    交给系统去报错——和这条改动之前的行为一致，不会把「打开一个不存在的文件」的提示换成别的。
 *  - 可执行位取 `mode & 0o111`（owner / group / other 任一）；目录一律不算（它们总有 x 位，打开目录就是开文件管理器）。
 *    代价：挂载的 FAT / exFAT 盘上文件常显示成全 0o777，从那里点「打开」会改成在文件管理器中显示——这是安全一侧的误报。
 *  - 已知局限：检查与真正打开之间仍有 TOCTOU 窗口（交给系统的是已解开链接的真实路径，窗口只剩「别人把这个文件本身换掉」，
 *    需要本机写权限）；没有加读盘超时（卡死的网络挂载上 stat 会挂住这个请求，之前这一步在子进程里）。
 */

import fs from "node:fs/promises";

import type { OpenPathFacts } from "@/lib/local-file-os";

export const probeOpenPathFacts = async (
  absPath: string,
  platform: NodeJS.Platform,
): Promise<OpenPathFacts | undefined> => {
  if (platform === "win32") return undefined;
  try {
    const realPath = await fs.realpath(absPath);
    const st = await fs.stat(realPath);
    return { realPath, executableFile: st.isFile() && (st.mode & 0o111) !== 0 };
  } catch {
    return undefined;
  }
};
