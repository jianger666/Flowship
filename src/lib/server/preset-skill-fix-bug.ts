/**
 * 出厂预置「改bug」skill 模板（原仓库 skills/fix-bug/SKILL.md）。
 * 启动时写入 `<dataRoot>/skills/fix-bug/SKILL.md`（用户可删；删过不重装）。
 *
 * LEGACY_V1 = 改造前出厂原文（历史上只有这一版）。启动时若磁盘内容与其 trim 精确相等，
 * 才覆盖写新模板——用户改过的不动。
 */

/** 改造前出厂原文（v1）；仅供存量精确匹配升级，勿当现行模板用 */
export const PRESET_FIX_BUG_SKILL_CONTENT_LEGACY_V1 = `---
name: fix-bug
description: >-
  推进「改bug」custom action 时必读：按 bug 描述复现 → 最小修复 → 自检 →
  写 artifact → meegle 评论回填；状态流转必须 ask_user，绝不可自行流转。
---

# 改bug

用户推进本 action 时，**指令里会带 bug 信息**（标题 / 链接 / 关联需求）。以指令为准；缺描述就用 meegle CLI 按链接 / id 拉详情。

## 目标

1. 按 bug 描述**复现**问题，写清复现路径  
2. **最小改动**修复  
3. **自检**（相关路径再走一遍）  
4. 写 artifact（问题定位 / 修复方案 / 验证）  
5. 用 meegle 在 **bug 工作项**回填评论；**是否流转到 RESOLVED 必须 ask_user**

## 步骤

### 1. 复现

- 读指令里的 bug 标题 / 链接；需要正文时：  
  \`meegle workitem get --project-key <key> --work-item-id <id> --fields name,work_item_status,priority,description,field_cf759f\`  
  （不要 \`--fields _all\`，会序列化报错）
- 在仓库里定位问题，artifact「问题定位」写清复现路径；复现不了先 \`ask_user\`，别瞎改

### 2. 修复

- 只改修这个 bug 必要的代码；不动无关文件、不顺手重构
- 分支铁律同 build：确认在本 task feature 分支上再改

### 3. 自检

- 按复现路径再验；能跑的检查（typecheck / lint / 相关单测）跑一下
- 结果写进 artifact「验证」

### 4. Artifact

按挂载壳 \`output\` 骨架写 \`actions/<n>-custom.md\`（问题定位 / 修复方案 / 验证）。写法见 \`artifact-writer\` skill。

### 5. 收尾（meegle）

1. **评论回填**（先做）：在 bug 工作项 \`comment add\`，写清已修、改动说明、MR 链接（有则附上）  
2. **状态流转（HITL）**：必须先 \`ask_user\` 问「是否把该 bug 流转到 RESOLVED？」  
   - 用户确认 → \`workflow list-state-transitions\` 找到目标 RESOLVED 的 transition → \`list-state-required\` 看必填 → 无阻塞再 \`workflow transition-state\`  
   - 用户拒绝 / 有必填字段盖不住 → **不要流转**，在 artifact 注明，让用户去飞书处理  
3. **铁律**：未经用户确认，**绝不**自行 \`transition-state\`

## 交卷

写完 artifact +（如适用）评论 / 流转后 \`submit_work\`，等用户 ack。
`;

/** 现行出厂模板（v2：疑问门 → 修复 → 验收门 → 可选建 MR+流转） */
export const PRESET_FIX_BUG_SKILL_CONTENT = `---
name: fix-bug
description: >-
  推进「改bug」custom action 时必读：疑问门 → 复现/最小修复/自检 → 验收门 →
  可选建 MR+流转 RESOLVED；未经 ask_user 确认绝不建 MR、绝不流转。
---

# 改bug

用户推进本 action 时，**指令里会带 bug 信息**（标题 / 链接 / 关联需求）。以指令为准；缺描述就用 meegle CLI 按链接 / id 拉详情。

## 目标

1. 拉详情后先**自查疑问**——有疑问 \`ask_user\`，没疑问再动手  
2. **复现** → **最小修复** → **自检**  
3. **验收门**：\`ask_user\` 请用户确认有没有问题；有问题继续改，直到确认没问题  
4. 验收通过后再问「要不要建 MR 并流转 RESOLVED」——用户要才建才转  
5. 写 artifact（问题定位 / 修复方案 / 验证 / MR+流转结果）后 \`submit_work\`

## 步骤

### 1. 疑问门（先做）

- 读指令里的 bug 标题 / 链接；需要正文时：  
  \`meegle workitem get --project-key <key> --work-item-id <id> --fields name,work_item_status,priority,description,field_cf759f\`  
  （不要 \`--fields _all\`，会序列化报错）
- 自查：复现路径清不清楚 / 期望行为明不明确 / 影响面有没有歧义  
  - **有疑问** → 先 \`ask_user\` 问清再动手  
  - **没疑问** → 直接进复现与修复

### 2. 复现

- 在仓库里定位问题，artifact「问题定位」写清复现路径  
- **复现不了先 \`ask_user\`，别瞎改**

### 3. 修复

- 只改修这个 bug 必要的代码；不动无关文件、不顺手重构  
- 分支铁律同 build：确认在本 task feature 分支上再改

### 4. 自检

- 按复现路径再验；能跑的检查（typecheck / lint / 相关单测）跑一下  
- 结果写进 artifact「验证」

### 5. 验收门

改完**不要直接收尾**。\`ask_user\` 简述改动点 + 验证方式，请用户确认「有没有问题」：  
- 用户反馈问题 → 继续改 → 再自检 → 再问，**循环到用户确认没问题**  
- 用户确认没问题 → 进入收尾

### 6. Artifact（可与验收穿插写）

按挂载壳 \`output\` 骨架写 \`actions/<n>-custom.md\`（问题定位 / 修复方案 / 验证；收尾后再补 MR+流转结果）。写法见 \`artifact-writer\` skill。

### 7. 收尾（建 MR + 流转，HITL）

验收通过后，\`ask_user\` **一次**问「要不要建 MR 并把 bug 流转到 RESOLVED？」（一个问题带选项，别拆两问）：

**用户要** → 按序：

1. **push** 当前 feature 分支（沿用 build 时的分支，**绝不 force push**）  
2. 调 \`submit_mr\` 建 MR——\`target_branch\` 用 super prompt「## 仓库分支配置」里该仓的**测试分支**；没配默认 \`test\`；**绝不探 origin/HEAD**（与 ship 口径一致）  
3. 把 MR 链接用 meegle \`comment add\` 评论到 **bug 工作项**（**只评论 bug 工作项，不要评论关联的原需求 story**）  
4. 流转 RESOLVED：\`workflow list-state-transitions\` → \`list-state-required\` → 无阻塞再 \`workflow transition-state\`；有必填字段盖不住 → **不要流转**，在 artifact 注明，让用户去飞书处理

**用户不要** → 只写 artifact，不建 MR、不流转

**铁律**：未经用户在本步确认，**绝不** \`transition-state\`，**绝不**自行建 MR

## 交卷

写完 artifact +（如适用）MR / 评论 / 流转后 \`submit_work\`，等用户 ack。
`;
