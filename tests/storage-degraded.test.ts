/**
 * 存储降级的文案与状态比较（R14 B2-2 / Q9-01 = Q15-02）：src/lib/storage-degraded.ts
 *
 * 事件写盘失败（磁盘满 / 数据目录只读 / IO 错误 / 被占用且重试穿透）时，服务端置「存储降级」标志，
 * 界面顶部画红条，服务端同时弹一条 error toast——两处说的话必须一致，所以文案只有 describeStorageDegraded 这一份。
 * 这里守四件事：
 *   ① 三档文案（按「用户该做什么」分，不按 errno 分）title / detail 逐字钉住；
 *   ② 不论以后怎么润色措辞，两条关键承诺必须还在：「恢复保存之前」内容可能丢、「下一次保存成功后」提示自动消失
 *      （不是「一腾出空间就消失」：恢复判定没有定时器，要等下一次成功写，且距最近一次失败满 10s）；
 *   ③ 文案写给普通用户看：任何一档都不带 errno 码（码只进服务端日志），也不能把入参 code 回显进文案；
 *   ④ sameStorageDegraded：null 只和 null 相同、有值只比 code。宿主（页面 / 聊天视图）靠它去重 setState，
 *      `{ code: "" }`（降级中、码未知）与 null（没降级）必须不同——否则服务端没给码时红条永远出不来。
 * 另有一条模块边界：它被客户端组件、task-store 与服务端 task-stream 三方共用，不能依赖 server-only 模块。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeStorageDegraded,
  sameStorageDegraded,
  type StorageDegradedState,
} from "@/lib/storage-degraded";

// 三档逐字文案（与 src/lib/storage-degraded.ts 一致）。故意写成完整字面量而不是拼接：
// 文案是产品承诺，要改措辞就该有意识地回来改这里，而不是让拼接把改动悄悄吞掉
const DISK_FULL = {
  title: "磁盘空间不足，新内容没能保存",
  detail:
    "在恢复保存之前，新产生的内容可能只显示在当前页面，刷新或重启后会丢失。请先释放磁盘空间，下一次保存成功后这条提示会自动消失。",
};
const READ_ONLY = {
  title: "数据目录是只读的，新内容没能保存",
  detail:
    "在恢复保存之前，新产生的内容可能只显示在当前页面，刷新或重启后会丢失。请检查数据目录所在的磁盘是否被设为只读或已卸载，下一次保存成功后这条提示会自动消失。",
};
const WRITE_FAILED = {
  title: "磁盘写入失败，新内容没能保存",
  detail:
    "在恢复保存之前，新产生的内容可能只显示在当前页面，刷新或重启后会丢失。请检查数据目录的权限和磁盘状态，下一次保存成功后这条提示会自动消失。",
};

/** 落到「写入失败」兜底档的输入：权限 / IO / 被占用 / 未知码 / 缺失值（帧里没带 code 时界面传空串） */
const FALLBACK_INPUTS: Array<{ label: string; code: string | null | undefined }> = [
  { label: "EIO", code: "EIO" },
  { label: "EACCES", code: "EACCES" },
  { label: "EPERM", code: "EPERM" },
  { label: "EBUSY", code: "EBUSY" },
  { label: "未知码 EWEIRD", code: "EWEIRD" },
  { label: "空串（帧里没带 code）", code: "" },
  { label: "undefined", code: undefined },
  { label: "null", code: null },
];

describe("describeStorageDegraded：三档文案（title / detail 逐字）", () => {
  it.each(["ENOSPC", "EDQUOT"])("%s → 磁盘空间不足档（配额用尽与空间用尽同一档）", (code) => {
    const copy = describeStorageDegraded(code);
    expect(copy.title).toBe(DISK_FULL.title);
    expect(copy.detail).toBe(DISK_FULL.detail);
  });

  it("EROFS → 只读档", () => {
    const copy = describeStorageDegraded("EROFS");
    expect(copy.title).toBe(READ_ONLY.title);
    expect(copy.detail).toBe(READ_ONLY.detail);
  });

  it.each(FALLBACK_INPUTS)("$label → 写入失败档（兜底，不会因为码不认识就没有文案）", ({ code }) => {
    const copy = describeStorageDegraded(code);
    expect(copy.title).toBe(WRITE_FAILED.title);
    expect(copy.detail).toBe(WRITE_FAILED.detail);
  });
});

describe("describeStorageDegraded：不论措辞怎么润色，这些承诺必须在", () => {
  // 三档各取一个代表码 + 兜底空串
  const REPRESENTATIVES = ["ENOSPC", "EROFS", "EIO", ""];

  it.each(REPRESENTATIVES)("码 %j：detail 说清「恢复保存之前」内容可能丢、「下一次保存成功后」提示自动消失", (code) => {
    const { detail } = describeStorageDegraded(code);
    // 用户据此决定「先把重要内容复制走」，也知道不用手动关这条提示
    expect(detail).toContain("恢复保存之前");
    expect(detail).toContain("自动消失");
    // 消失的时机要说准：不是「腾出空间的瞬间」，而是下一次保存成功（恢复判定没有定时器，空闲时红条会一直挂着）
    expect(detail).toContain("下一次保存成功后");
    expect(detail).not.toContain("恢复保存后");
  });

  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM", "EBUSY", "EWEIRD"])(
    "码 %s：文案不带 errno 码，也不把入参回显进文案（码只进服务端日志）",
    (code) => {
      const { title, detail } = describeStorageDegraded(code);
      const text = `${title}\n${detail}`;
      expect(text).not.toContain(code);
      // 兜底：任何三个以上连续大写字母（errno 码 / ERR_ 之类内部标识）都不该出现在面向用户的文案里
      expect(text).not.toMatch(/[A-Z]{3,}/);
    },
  );

  it("三档的 title 互不相同（红条与 toast 靠标题让用户一眼分清是哪类问题）", () => {
    const titles = new Set([
      describeStorageDegraded("ENOSPC").title,
      describeStorageDegraded("EROFS").title,
      describeStorageDegraded("EIO").title,
    ]);
    expect(titles.size).toBe(3);
  });
});

describe("sameStorageDegraded：null 只和 null 相同，有值只比 code", () => {
  const shared: StorageDegradedState = { code: "ENOSPC" };
  const CASES: Array<{
    label: string;
    a: StorageDegradedState | null;
    b: StorageDegradedState | null;
    same: boolean;
  }> = [
    { label: "null / null", a: null, b: null, same: true },
    { label: "null / 有值", a: null, b: { code: "ENOSPC" }, same: false },
    { label: "有值 / null", a: { code: "ENOSPC" }, b: null, same: false },
    { label: "同 code、不同对象（bootstrap 补发与实时帧是两个对象）", a: { code: "ENOSPC" }, b: { code: "ENOSPC" }, same: true },
    { label: "同一个对象引用", a: shared, b: shared, same: true },
    { label: "异 code", a: { code: "ENOSPC" }, b: { code: "EROFS" }, same: false },
    { label: "空串 code / 空串 code", a: { code: "" }, b: { code: "" }, same: true },
    // 下面两条是真正会出事的边界：「降级中、码未知」不能被当成「没降级」
    { label: "空串 code / null（降级中 ≠ 没降级）", a: { code: "" }, b: null, same: false },
    { label: "null / 空串 code（没降级 → 降级中、码未知）", a: null, b: { code: "" }, same: false },
    { label: "空串 code / 有码", a: { code: "" }, b: { code: "EIO" }, same: false },
  ];

  it.each(CASES)("$label → $same", ({ a, b, same }) => {
    expect(sameStorageDegraded(a, b)).toBe(same);
    // 对称：宿主传参顺序（prev, next）不能影响结论
    expect(sameStorageDegraded(b, a)).toBe(same);
  });
});

describe("共用模块边界：客户端组件 / task-store / 服务端 task-stream 都 import 它", () => {
  const MODULE = path.resolve(import.meta.dirname, "..", "src", "lib", "storage-degraded.ts");
  // 去掉注释再找 import（文件头注释里就写着「无 server-only 依赖」，不剥会误伤）
  const importSpecs = (raw: string): string[] => {
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return [...code.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  };
  const SERVER_ONLY = /^(?:@\/lib\/server(?:\/|$)|node:|server-only$)/;

  it("不 import @/lib/server/*、node 内建模块、server-only（否则客户端 bundle 直接崩）", () => {
    for (const spec of importSpecs(readFileSync(MODULE, "utf-8"))) {
      expect(spec, `storage-degraded.ts 不该依赖 ${spec}`).not.toMatch(SERVER_ONLY);
    }
  });

  it("自检：上面这条检查对服务端依赖真会报（别让它是个摆设）", () => {
    const bad = [
      'import { x } from "@/lib/server/task-fs";',
      'import "server-only";',
      'import fs from "node:fs";',
      '// import y from "node:path"   ← 注释里的不算',
    ].join("\n");
    expect(importSpecs(bad).filter((s) => SERVER_ONLY.test(s))).toEqual([
      "@/lib/server/task-fs",
      "server-only",
      "node:fs",
    ]);
  });
});
