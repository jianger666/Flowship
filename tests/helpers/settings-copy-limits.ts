/**
 * 设置行文案的字数上限，以及扫描「谁超了」的纯函数（S-4）。
 * tests/settings-hint-brevity.test.ts 与 tests/browser-settings-copy.test.ts 共用这一份，数字只在这里出现一次；
 * src/components/ui/setting-row.tsx 头注释指到这里，不再自己写数字（以前「约 40 字」和 60 并存）。
 *
 * 数字怎么来的（2026-11-24，S-1 / S-2 / S-8 改完文案之后实测）：
 *   hint 现有最长 62 字（飞书「限制群里非宿主成员」，要点出同权时仍被拒的几类）；浏览器卡最长 61 字（本机证书）。
 *   取 62 × 1.1 ≈ 68，留约 10% 余量。
 *   detail 现有最长 128 字（页面脚本总闸，要写全它顺带管的几项）；128 × 1.1 ≈ 140。
 * 往上调这两个数 = 承认「一句话」又变长了：要在评审里说理由，别顺手改大了事。
 *
 * R20-13 的两处订正：
 *   - 飞书「限制群里非宿主成员」那条改成点名四类 + 「浏览器里的敏感能力」后降到 60 字（完整清单在折叠区），现存最长 hint 是浏览器卡本机证书的 61 字；
 *   - 原来 settings-hint-brevity.test.ts 里还有一条「最长的离上限至少留 5% 余量」：它让实际可用的上限变成 64 / 133，低于这里声明的 68 / 140
 *     （同一组数字两个口径）。已去掉，改为「钉死这两个数」——上限就是声明的这两个数，调大要改测试并说理由。
 */
export const HINT_MAX = 68;
export const DETAIL_MAX = 140;

export interface CopyItem {
  /** 出处，报错时用（如 "browser.evaluate" / "feishu.nonOwnerGuard"） */
  source: string;
  hint?: string;
  detail?: string;
}

/** 所有超过上限（或 hint 含换行）的项，格式化成一行行可读的报错；空数组 = 全部合格 */
export const findOverLimit = (items: readonly CopyItem[], limits = { hint: HINT_MAX, detail: DETAIL_MAX }): string[] => {
  const bad: string[] = [];
  for (const it of items) {
    if (it.hint !== undefined) {
      if (it.hint.length > limits.hint) bad.push(`${it.source} 的 hint 超长（${it.hint.length} > ${limits.hint}）：${it.hint.slice(0, 30)}…`);
      if (/[\r\n]/.test(it.hint)) bad.push(`${it.source} 的 hint 里有换行`);
    }
    if (it.detail !== undefined && it.detail.length > limits.detail) {
      bad.push(`${it.source} 的 detail 超长（${it.detail.length} > ${limits.detail}）：${it.detail.slice(0, 30)}…`);
    }
  }
  return bad;
};
