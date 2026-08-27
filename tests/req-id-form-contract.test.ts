/**
 * REQ-ID 两个表单的接线契约（新建表单 + 编辑弹窗）
 *
 * 判定本体（`reqIdPatchValue`）由 tests/req-id.test.ts 覆盖；这里锁的是「表单真的走它」
 * 以及「两处长得一样」——历史上这两条各踩过一次：
 *   - 编辑弹窗自己写过一版「当前草稿 ≠ 新链接派生值 = 手填」，把展示用的旧派生值落了库；
 *   - 输入框预填派生值本身也是错的（规范要求没有 REQ-ID 就找用户要、不要猜）。
 * 现在两处都是「默认留空、填了什么存什么」，别再长出第三种写法。
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），所以走源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

const editDialog = read("components", "tasks", "edit-task-dialog.tsx");
const launchForm = read("components", "tasks", "task-launch-form.tsx");

describe("两个表单都不预填、不派生", () => {
  it("派生函数已经不存在了、谁也别再 import", () => {
    for (const source of [editDialog, launchForm]) {
      expect(source).not.toContain("deriveReqId");
      expect(source).not.toContain("reqIdFromStoryUrl");
    }
  });

  it("新建表单的编号草稿初值是空串", () => {
    expect(launchForm).toContain('const [reqId, setReqId] = useState("")');
  });

  it("编辑弹窗只回填库里存的手填值（没有就空着）", () => {
    // 初值 + 每次打开重灌都走这一份口径
    const backfill = 'setReqId(normalizeReqId(t.reqId) ?? "")';
    expect(editDialog).toContain(backfill);
    expect(editDialog).toContain(
      'useState(() => normalizeReqId(task.reqId) ?? "")',
    );
    // 打开后不再有「跟着飞书链接重算编号」的 effect
    expect(editDialog).not.toContain("reqIdTouched");
  });
});

describe("提交判定共用一份、两处文案一致", () => {
  it("都走 reqIdPatchValue、不在组件里自拼判定", () => {
    for (const source of [editDialog, launchForm]) {
      expect(source).toContain("reqIdPatchValue(");
      expect(source).not.toContain("reqId.trim() !==");
    }
  });

  it("新建用 Field 说明、编辑用 placeholder，都告诉用户可后补", () => {
    expect(launchForm).toContain(
      'activateEnabled ? "激活后由 Hub 生成" : "可后补"',
    );
    expect(editDialog).toContain('placeholder="暂无 REQ-ID、可后补"');
  });
});
