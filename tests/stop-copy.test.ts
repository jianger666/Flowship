/**
 * 「停止之后会发生什么 / 怎么继续」文案单一来源（第三轮 review D8-06 / D8-04）。
 *
 * 之前三处各写各的（确认框说「说句话唤醒」、停止后 info 说「可重新推进」、boot-recovery 说「重新发起」），
 * 现在由 lib/stop-copy 一处出，行为测试钉：
 * - 三处文案都引用同一对继续方式（说话继续本步 / 点「推进」开始下一步；chat 只有「继续发消息」）；
 * - 停止确认框在有排队时点明会被清掉、并只数 app 来源（群来源保留）；
 * - 划除自动收尾不写成「用户停止」；
 * - 服务端真实出口（stop-task 的事件、task-fs 的 boot-recovery）确实走这个模块（接线补充，不替代行为测试）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BOOT_RECOVERY_TEXT,
  CHAT_RESUME_HINT,
  TASK_RESUME_HINT,
  resumeHintFor,
  stopConfirmDescription,
  stopNoticeText,
  stoppableQueuedCount,
} from "@/lib/stop-copy";

describe("stopNoticeText：停止后写进事件流的 info", () => {
  it("task 用户停止：点名「说话继续本步 / 点推进开始下一步」", () => {
    const t = stopNoticeText({ mode: "task", trigger: "stop", actionLabel: " 出方案 action" });
    expect(t).toBe(`用户停止了 出方案 action（agent 已中断、${TASK_RESUME_HINT}）`);
    expect(t).toContain("说句话继续本步");
    expect(t).toContain("「推进」开始下一步");
  });

  it("缺省 trigger = 用户停止；无当前 action 时没有多余空格", () => {
    expect(stopNoticeText({ mode: "task" })).toBe(`用户停止了（agent 已中断、${TASK_RESUME_HINT}）`);
    expect(stopNoticeText({ mode: undefined })).toBe(`用户停止了（agent 已中断、${TASK_RESUME_HINT}）`);
  });

  it("划除触发的自动收尾：写「划除时自动停止」，不能写成用户点了停止", () => {
    const t = stopNoticeText({ mode: "task", trigger: "exclude", actionLabel: " 写代码 action" });
    expect(t).toBe(`划除时自动停止了 写代码 action（agent 已中断、${TASK_RESUME_HINT}）`);
    expect(t).not.toContain("用户停止");
  });

  it("chat 没有「推进」：只说继续发消息", () => {
    const t = stopNoticeText({ mode: "chat", actionLabel: " 忽略我 action" });
    expect(t).toBe(`用户停止了对话（agent 已中断、${CHAT_RESUME_HINT}）`);
    expect(t).not.toContain("推进");
  });
});

describe("stopConfirmDescription：task 停止确认框", () => {
  it("没有排队：不提队列，仍说半成品风险与继续方式", () => {
    const d = stopConfirmDescription();
    expect(d).toContain("可能留下半成品");
    expect(d).toContain(TASK_RESUME_HINT);
    expect(d).not.toContain("排队");
    expect(stopConfirmDescription({ queuedCount: 0 })).toBe(d);
  });

  it("有排队：点明条数会被清掉，并说明会留「未送达」记录可复制（D8-04 不再静默）", () => {
    const d = stopConfirmDescription({ queuedCount: 3 });
    expect(d).toContain("3 条消息会被清掉");
    expect(d).toContain("未送达");
    expect(d).toContain("可复制");
    // 继续方式仍在末尾、与无排队时同一句
    expect(d.endsWith(`停止后${TASK_RESUME_HINT}。`)).toBe(true);
  });

  it("非法条数（负数 / NaN / 小数）按保守口径：不当有排队、小数取整", () => {
    expect(stopConfirmDescription({ queuedCount: -2 })).not.toContain("排队");
    expect(stopConfirmDescription({ queuedCount: Number.NaN })).not.toContain("排队");
    expect(stopConfirmDescription({ queuedCount: 2.9 })).toContain("2 条消息");
  });
});

describe("stoppableQueuedCount：只数停止会清掉的（与服务端 onlySources:['app'] 同口径）", () => {
  it("app 来源算；群来源（属主群话 / 托办回执 / 群提问）保留、不算", () => {
    expect(
      stoppableQueuedCount([
        { source: "app" },
        { source: "app" },
        { source: "group_owner" },
        { source: "group_reply" },
        { source: "group_question" },
      ]),
    ).toBe(2);
  });

  it("空 / null / undefined → 0", () => {
    expect(stoppableQueuedCount([])).toBe(0);
    expect(stoppableQueuedCount(null)).toBe(0);
    expect(stoppableQueuedCount(undefined)).toBe(0);
  });
});

describe("BOOT_RECOVERY_TEXT：boot-recovery 事件正文", () => {
  it("保留 [boot-recovery] 前缀（其它测试 / 过滤靠它）并用同一说法：说话继续，task 另可点推进", () => {
    expect(BOOT_RECOVERY_TEXT.startsWith("[boot-recovery] ")).toBe(true);
    expect(BOOT_RECOVERY_TEXT).toContain("说句话继续本步");
    expect(BOOT_RECOVERY_TEXT).toContain("「推进」开始下一步");
    // 不再是只说「重新发起」的第三套口径
    expect(BOOT_RECOVERY_TEXT).not.toContain("重新发起即可恢复");
  });
});

describe("接线（补充）：三个出口都走 lib/stop-copy，不再各写各的", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("stop-task 的停止事件走 stopNoticeText，不再内联「可重新「推进」」", () => {
    const src = read("src/lib/server/stop-task.ts");
    expect(src).toMatch(/stopNoticeText\(/);
    expect(src).not.toContain("可重新「推进」");
  });

  it("task-fs 的 boot-recovery 走 BOOT_RECOVERY_TEXT", () => {
    const src = read("src/lib/server/task-fs.ts");
    expect(src).toMatch(/text:\s*BOOT_RECOVERY_TEXT/);
    expect(src).not.toContain("重新发起即可恢复");
  });

  it("task 页停止确认框走 stopConfirmDescription，并把输入条排队数传进去", () => {
    const src = read("src/app/tasks/[id]/page.tsx");
    expect(src).toMatch(/stopConfirmDescription\(\{\s*queuedCount:\s*stoppableQueuedCount\(talkQueue\)/);
    expect(src).not.toContain("停止后在底部输入条说句话即可唤醒继续");
  });
});

// ---------- Q6-07：「断开 / 唤醒」类恢复文案并入同一口径 ----------

describe("resumeHintFor：按模式取同一句「怎么继续」（Q6-07）", () => {
  it("chat → 可继续发消息；task / 未知 → 说句话继续本步或点「推进」", () => {
    expect(resumeHintFor("chat")).toBe(CHAT_RESUME_HINT);
    expect(resumeHintFor("task")).toBe(TASK_RESUME_HINT);
    expect(resumeHintFor(undefined)).toBe(TASK_RESUME_HINT);
  });

  it("chat 的恢复提示里不会出现「推进」（chat 没有这个按钮）", () => {
    expect(resumeHintFor("chat")).not.toContain("推进");
  });

  it("停止确认框：纯图片 / 文件条的措辞（Q6-04）——只承诺文字可复制，图片 / 文件需重新添加", () => {
    const d = stopConfirmDescription({ queuedCount: 2 });
    expect(d).toContain("文字可复制回去重发");
    expect(d).toContain("图片 / 文件需重新添加");
  });
});

describe("接线（补充）：断开 / 唤醒 / 没交卷的恢复文案不再另写一套（Q6-07）", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const OLD_PHRASES = ["说句话即可唤醒", "说句话即可继续", "说句话或重新「推进」即可继续", "重新「推进」。"];

  it.each([
    "src/app/api/tasks/[id]/ask-reply/route.ts",
    "src/components/tasks/ask-user-inline.tsx",
    "src/lib/server/task-runner.ts",
  ])("%s 不再内联旧措辞", (rel) => {
    const src = read(rel);
    for (const phrase of OLD_PHRASES) expect(src).not.toContain(phrase);
  });

  it("三处都改走 lib/stop-copy 的常量 / resumeHintFor", () => {
    expect(read("src/app/api/tasks/[id]/ask-reply/route.ts")).toMatch(/resumeHintFor\(isChat \? "chat" : "task"\)/);
    expect(read("src/components/tasks/ask-user-inline.tsx")).toMatch(/resumeHintFor\(task\.mode\)/);
    expect(read("src/lib/server/task-runner.ts")).toMatch(/下一步：\$\{TASK_RESUME_HINT\}/);
  });
});

describe("第五轮 P4：task-runner 自动压缩续接失败的恢复文案走 stop-copy", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/server/task-runner.ts"), "utf8");

  it("不再硬编码「请在底部输入条说句话唤醒本阶段继续」，改用 resumeHintFor(task.mode)（chat 没有「推进」）", () => {
    expect(src).not.toContain("请在底部输入条说句话唤醒本阶段继续");
    expect(src).toMatch(/自动压缩续接失败：\$\{resumeHintFor\(task\.mode\)\}/);
  });
});
