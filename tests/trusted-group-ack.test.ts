/**
 * 需求群「只绑可信内部群」的告知与一次性确认（B4-4 / Q12b-05）
 *   src/lib/trusted-group-ack.ts + src/components/tasks/requirement-group-dialog.tsx
 *
 * 背景：群里任何能 @ 机器人的成员提问，机器人都会以属主的身份在本机起答疑 Agent（提示词约束，没有执行层边界），
 * 绑进有外部人员的群 = 把凭据交出去。代码里写明了，但绑群那一刻从来没告诉过属主。
 * 现在：弹窗里常驻一行说明（手动绑定 / 自动创建都有）；第一次手动绑定前多一次确认，点过就记 localStorage 不再打断。
 *
 * 分两层：
 *  ① lib：文案逐字钉住；ack 读写（注入 storage，读写失败都不抛）；
 *  ② 弹窗接线：项目里没有 DOM 测试环境，而 Dialog 走 portal、SSR 渲染不出内容，所以用源码契约
 *     （说明在两个模式里都渲染、确认在绑定调用之前且只在没确认过时弹、确认后才记 ack、同群提示接在成功分支里）。
 *
 * ⚠ 只做了纯函数 + 源码层检查：没有在真实浏览器 / Electron 窗口里看过弹窗里这行字与确认框的实际观感。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRUSTED_GROUP_ACK_KEY,
  TRUSTED_GROUP_CONFIRM_LABEL,
  TRUSTED_GROUP_CONFIRM_TITLE,
  TRUSTED_GROUP_NOTICE,
  browserAckStorage,
  hasTrustedGroupAck,
  writeTrustedGroupAck,
  type AckStorage,
} from "@/lib/trusted-group-ack";

const memoryStorage = (initial: Record<string, string> = {}): AckStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("文案", () => {
  it("常驻说明逐字固定（说清谁、以谁的身份、做什么、该绑什么群）", () => {
    expect(TRUSTED_GROUP_NOTICE).toBe(
      "群里任何成员 @ 机器人，机器人都会以你的身份读取本机文件来答疑。只绑定都是可信同事的内部群。",
    );
  });

  it("确认框的标题与按钮", () => {
    expect(TRUSTED_GROUP_CONFIRM_TITLE).toBe("这个群里都是可信的同事吗？");
    expect(TRUSTED_GROUP_CONFIRM_LABEL).toBe("都是同事，继续绑定");
  });
});

describe("hasTrustedGroupAck / writeTrustedGroupAck", () => {
  it("没记过 → false；写过 → true；key 固定带 flowship: 前缀", () => {
    const s = memoryStorage();
    expect(hasTrustedGroupAck(s)).toBe(false);
    writeTrustedGroupAck(s);
    expect(TRUSTED_GROUP_ACK_KEY).toBe("flowship:requirement-group-trusted-ack");
    expect(s.data).toEqual({ [TRUSTED_GROUP_ACK_KEY]: "1" });
    expect(hasTrustedGroupAck(s)).toBe(true);
  });

  it.each(["0", "true", "yes", ""])("存的是 %j（不是 \"1\"）→ 当没确认过，宁可多问一次", (v) => {
    expect(hasTrustedGroupAck(memoryStorage({ [TRUSTED_GROUP_ACK_KEY]: v }))).toBe(false);
  });

  it("没有 storage（服务端渲染 / 被禁用）：读 false、写不动也不抛", () => {
    expect(hasTrustedGroupAck(null)).toBe(false);
    expect(() => writeTrustedGroupAck(null)).not.toThrow();
  });

  it("storage 读 / 写抛错（隐私模式、配额）：读当没确认，写吞掉", () => {
    const broken: AckStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(hasTrustedGroupAck(broken)).toBe(false);
    expect(() => writeTrustedGroupAck(broken)).not.toThrow();
  });
});

describe("browserAckStorage", () => {
  it("node（没有 window）→ null", () => {
    expect(browserAckStorage()).toBeNull();
  });

  it("有 window.localStorage → 返回它", () => {
    const s = memoryStorage();
    vi.stubGlobal("window", { localStorage: s });
    expect(browserAckStorage()).toBe(s);
  });

  it("访问 localStorage 本身就抛（存储被禁用）→ null，不抛", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(browserAckStorage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 弹窗接线（源码契约）
// ---------------------------------------------------------------------------

const dialogSrc = readFileSync(
  path.resolve(import.meta.dirname, "..", "src/components/tasks/requirement-group-dialog.tsx"),
  "utf8",
);

/** runBind 的函数体（到 runClear 之前） */
const runBindBody = (): string => {
  const start = dialogSrc.indexOf("const runBind = useCallback(");
  const end = dialogSrc.indexOf("const runClear = useCallback(");
  expect(start, "找不到 runBind").toBeGreaterThan(-1);
  expect(end, "找不到 runClear").toBeGreaterThan(start);
  return dialogSrc.slice(start, end);
};

describe("弹窗接线：常驻说明", () => {
  it("手动绑定与自动创建两个模式的区块里各渲染一次，样式是 text-xs text-muted-foreground", () => {
    const noticeParagraph = /<p className="text-xs text-muted-foreground">\{TRUSTED_GROUP_NOTICE\}<\/p>/g;
    const hits = [...dialogSrc.matchAll(noticeParagraph)].map((m) => m.index!);
    expect(hits).toHaveLength(2);
    const manualAt = dialogSrc.indexOf('{mode === "manual" && (');
    const autoAt = dialogSrc.indexOf('{mode === "auto" && (');
    const footerAt = dialogSrc.indexOf("<DialogFooter");
    expect(manualAt).toBeGreaterThan(-1);
    expect(autoAt).toBeGreaterThan(manualAt);
    expect(footerAt).toBeGreaterThan(autoAt);
    // 一条在手动区块里，一条在自动区块里
    expect(hits[0]!).toBeGreaterThan(manualAt);
    expect(hits[0]!).toBeLessThan(autoAt);
    expect(hits[1]!).toBeGreaterThan(autoAt);
    expect(hits[1]!).toBeLessThan(footerAt);
  });

  it("文案来自 lib 常量，弹窗里没有另写一份字面量", () => {
    expect(dialogSrc).not.toContain("只绑定都是可信同事的内部群");
  });
});

describe("弹窗接线：第一次手动绑定前的确认", () => {
  it("只在没确认过时弹；用户取消就直接返回，不继续绑定", () => {
    const body = runBindBody();
    expect(body).toMatch(/const ackStorage = browserAckStorage\(\);\s*if \(!hasTrustedGroupAck\(ackStorage\)\) \{/);
    expect(body).toMatch(
      /const trusted = await confirm\(\{\s*title: TRUSTED_GROUP_CONFIRM_TITLE,\s*description: TRUSTED_GROUP_NOTICE,\s*confirmLabel: TRUSTED_GROUP_CONFIRM_LABEL,\s*\}\);\s*if \(!trusted\) return;/,
    );
  });

  it("确认之后才记 ack（取消不记），并且都发生在真正调用绑定接口之前", () => {
    const body = runBindBody();
    const at = (needle: string): number => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const ackCheck = at("hasTrustedGroupAck(ackStorage)");
    const trustedConfirm = at("const trusted = await confirm(");
    const cancelReturn = at("if (!trusted) return;");
    const ackWrite = at("writeTrustedGroupAck(ackStorage)");
    const bindCall = at("await bindRequirementGroup(taskId, parsed)");
    expect(ackCheck).toBeLessThan(trustedConfirm);
    expect(trustedConfirm).toBeLessThan(cancelReturn);
    expect(cancelReturn).toBeLessThan(ackWrite);
    expect(ackWrite).toBeLessThan(bindCall);
  });

  it("以「确认过没有」为准、不看当前有没有关联；覆盖写确认仍在其后", () => {
    const body = runBindBody();
    // 条件里没有 `bound` —— 只剩项目群默认的人同样没被告知过
    const cond = /if \(!hasTrustedGroupAck\(ackStorage\)\) \{/.exec(body);
    expect(cond).not.toBeNull();
    expect(body.indexOf("title: \"确认换关联的群？\"")).toBeGreaterThan(body.indexOf("writeTrustedGroupAck(ackStorage)"));
  });

  it("输入校验（空 / 多个 ID / 格式不对 / 与当前相同）都在确认之前拦掉，不会白弹一次确认", () => {
    const body = runBindBody();
    const trustedConfirm = body.indexOf("const trusted = await confirm(");
    for (const guard of [
      'setFieldError("请先粘贴群 ID")',
      "检测到多个群 ID",
      "没找到 oc_ 开头的群 ID",
      "这个群已经是当前关联的群，不用重复绑定",
    ]) {
      const i = body.indexOf(guard);
      expect(i, guard).toBeGreaterThan(-1);
      expect(i, guard).toBeLessThan(trustedConfirm);
    }
  });
});

describe("弹窗接线：绑完提示同群还有别的任务", () => {
  it("成功分支里、刷新任务与关闭弹窗之前弹 warning；文案来自 lib，停留 10 秒（弹窗马上关）", () => {
    const body = runBindBody();
    const warn = body.indexOf("toast.warning(describeAlsoBoundBy(r.alsoBoundBy), { duration: 10_000 });");
    const success = body.indexOf("toast.success(");
    const refresh = body.indexOf("onTaskUpdateRef.current(r.task);");
    expect(warn).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(-1);
    expect(success).toBeLessThan(warn);
    expect(warn).toBeLessThan(refresh);
    expect(body).toMatch(/if \(r\.alsoBoundBy && r\.alsoBoundBy\.length > 0\) \{/);
  });
});
