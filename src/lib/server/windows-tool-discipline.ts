/**
 * Windows 工具翻车纪律（路线图 L1、chat / task prompt 单一源）
 *
 * 背景（线上实锤）：Windows 同事的 agent 对 GBK/CRLF Java 文件 read 失败 → grep 失败 →
 * edit 连败十几次 → PowerShell here-string / node -e / 临时 js / StrReplace 兔子洞，
 * 烧几万 token。内置工具对遗留编码不可靠时，与其继续硬试或进 shell 脚本，不如停手让用户处理。
 * 仅 win32 注入；PowerShell 语法条只在当前壳是 PowerShell 时加
 *（SHELL 已切 Git Bash 则不适用）。
 */

import {
  detectAgentShellKind,
  type AgentShellKind,
} from "./shell-boost";

/**
 * 组装 Windows 工具纪律段。非 win32 返空串（调用方可不注入 / 注入空占位）。
 * shellKind 可注入便于单测；默认跟 SDK 选壳简版探测。
 */
export const buildWindowsToolDisciplineDirective = (
  shellKind: AgentShellKind = detectAgentShellKind(),
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") return "";

  const lines: string[] = [
    "## Windows 工具纪律",
    "",
    // 最小失败纪律：内置 read/edit 对 GBK/UTF-16 等遗留编码不可靠。
    // 连败后停手告知用户，禁止继续换工具硬试、禁止进 shell / 临时脚本兔子洞。
    "- **最小失败纪律**：同一文件上 `read` / `edit` / StrReplace 连续失败 2 次（读出乱码也算失败）→ 停手，向用户直接说明该文件可能是 GBK/UTF-16 等遗留编码、内置工具读写不可靠，请用户自行处理或转码。**禁止**继续换内置工具硬试；**禁止**进 shell / 临时脚本（python 字节诊断、node -e、PowerShell here-string 等）兔子洞。",
  ];

  // Git Bash 下 POSIX 语法可用，PowerShell 坑不注入
  if (shellKind === "PowerShell") {
    lines.push(
      "- **PowerShell 语法**：禁用 `&&`（改用 `;`）；禁止内联 JSON / here-string 传复杂内容（落到临时文件再读）；**禁止用 `Set-Content` / here-string 写含中文的源码**——含中文内容一律用内置 `edit` / `write` 工具写入。",
    );
  }

  return lines.join("\n");
};
