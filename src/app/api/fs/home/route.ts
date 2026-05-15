/**
 * GET /api/fs/home
 *
 * 拿 server 端 $HOME 路径 + 几个常用快捷入口（Documents / Desktop / Downloads / cwd）
 * 给 FsPickerDialog 打开时的「快捷入口」侧边栏用、首次启动默认起始路径用。
 *
 * 返回里所有 path 都是绝对路径、不存在的也照样返、UI 侧自己判 / 给 disabled。
 * 反正后续 /api/fs/list 会再 stat、不存在那边会 404、UI 给 toast。
 */

import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";

export interface FsHomeShortcut {
  // UI 显示用、比如 "主目录" / "Documents" / "当前项目"
  label: string;
  // 绝对路径
  path: string;
}

export interface FsHomeResponse {
  home: string;
  cwd: string;
  shortcuts: FsHomeShortcut[];
}

export const GET = () => {
  const home = os.homedir();
  const cwd = process.cwd();
  const shortcuts: FsHomeShortcut[] = [
    { label: "主目录", path: home },
    { label: "Documents", path: path.join(home, "Documents") },
    { label: "Desktop", path: path.join(home, "Desktop") },
    { label: "Downloads", path: path.join(home, "Downloads") },
    { label: "当前项目", path: cwd },
  ];
  const body: FsHomeResponse = { home, cwd, shortcuts };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
