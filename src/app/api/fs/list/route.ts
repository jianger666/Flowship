/**
 * GET /api/fs/list?path=<abs>&showHidden=<bool>
 *
 * 服务端文件系统浏览：列某个绝对路径目录下的 entries、返回带绝对路径的 children。
 *
 * 为什么需要：浏览器沙箱拿不到本地绝对路径、osascript 又只支持 macOS、
 *   所以做了个「服务端文件浏览器」、让 FsPickerDialog UI 通过这个 API 翻目录、
 *   最终拿到 server 真实文件系统上的绝对路径、给设置页（仓库 cwd）和 chat（附文件）用。
 *
 * 安全语义：本服务是 dev server、跑在用户本机、不对外暴露。
 *   - 我们不做 $HOME 沙箱限制：用户想浏览外接硬盘 / /Volumes / /etc 都应该允许
 *   - path 必须是绝对路径（防 cwd-relative 把 process.cwd() 当根、产生 surprise）
 *   - 错误一律返回 JSON、UI 拿到 message 提示用户
 *
 * 黑名单：默认隐藏 node_modules / .git / 常见 build 产物、避免大目录卡 UI
 *   - 用户勾「显示全部」就给所有项
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

export interface FsEntry {
  // 仅文件 / 目录名（不含路径）、UI 显示用
  name: string;
  // 绝对路径、UI 点击进 / 用户最终拿来给 AI 的就是这个
  absPath: string;
  isDir: boolean;
  // 不读 stat 慢、但 list 时顺手拿、UI 排序 / 显示用
  sizeBytes?: number;
  modifiedAt?: number;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

// 默认隐藏的目录 / 文件名（即使不勾「显示隐藏」也跳过）
// 这些是「视觉噪声」（node_modules 上万条）/ 系统垃圾（.DS_Store）、
// 用户**几乎不会**想给 AI 看 node_modules 内部、所以默认隐
const ALWAYS_HIDDEN = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".DS_Store",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  "dist",
  "build",
  "out",
  "coverage",
  ".nuxt",
  ".vercel",
  ".idea",
  ".vscode",
]);

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  const showHidden = url.searchParams.get("showHidden") === "true";

  if (!rawPath || !rawPath.trim()) return errorJson("path 必填");
  // 规范化：把 ~ 展开、把多余 / 折叠、要求绝对路径
  let target = rawPath.trim();
  if (target.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (!home) return errorJson("无法解析 ~（$HOME 未设置）");
    target = path.join(home, target.slice(1));
  }
  target = path.resolve(target);
  if (!path.isAbsolute(target)) return errorJson("path 必须是绝对路径");

  let stat;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return errorJson("路径不存在", 404);
    if (code === "EACCES") return errorJson("无权限读取该目录", 403);
    return errorJson(`stat 失败：${(err as Error).message}`, 500);
  }
  if (!stat.isDirectory()) return errorJson("不是目录", 400);

  let raw: Array<{ name: string; isDir: boolean }>;
  try {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    raw = dirents.map((d) => ({
      name: d.name,
      // 软链接：尝试解析为目标类型、失败按非目录处理（不递归追、防循环）
      isDir: d.isDirectory() || (d.isSymbolicLink() && false),
    }));
    // 软链接单独再 stat 拿真实类型（dirent.isDirectory 对 symlink 是 false）
    // 不阻塞主路径、并发跑、失败的忽略
    await Promise.all(
      dirents.map(async (d, i) => {
        if (!d.isSymbolicLink()) return;
        try {
          const s = await fs.stat(path.join(target, d.name));
          raw[i]!.isDir = s.isDirectory();
        } catch {
          // 失效软链 / 权限、留 false
        }
      }),
    );
  } catch (err) {
    return errorJson(`readdir 失败：${(err as Error).message}`, 500);
  }

  // 过滤：黑名单 / 隐藏文件（按 showHidden 决定）
  let filtered = raw.filter((e) => {
    if (ALWAYS_HIDDEN.has(e.name)) return false;
    if (!showHidden && e.name.startsWith(".")) return false;
    return true;
  });
  // 排序：目录在前、字母序、不区分大小写
  filtered = filtered.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" });
  });

  // 顺手取每个 entry 的 stat（size + mtime）、UI 排序 / 显示用
  // 并发跑、失败的忽略（symlink 失效 / 权限不足）
  const entries: FsEntry[] = await Promise.all(
    filtered.map(async (e) => {
      const absPath = path.join(target, e.name);
      try {
        const s = await fs.stat(absPath);
        return {
          name: e.name,
          absPath,
          isDir: e.isDir,
          sizeBytes: e.isDir ? undefined : s.size,
          modifiedAt: s.mtimeMs,
        };
      } catch {
        return { name: e.name, absPath, isDir: e.isDir };
      }
    }),
  );

  // parent：根目录 / 则 null
  const parent = target === path.parse(target).root ? null : path.dirname(target);

  const body: FsListResponse = { path: target, parent, entries };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
