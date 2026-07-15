/**
 * 出厂预置「改bug」skill 模板（原仓库 skills/fix-bug/SKILL.md）。
 * 启动时写入 `<dataRoot>/skills/fix-bug/SKILL.md`（用户可删；删过不重装）。
 */

export const PRESET_FIX_BUG_SKILL_CONTENT = `---
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
