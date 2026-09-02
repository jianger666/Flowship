# 需求群协作（Feishu Group Collab）

> 设计文档 / 接力说明。
> 一期：server 基础层 + 分享闭环（API + MCP）。二期：群内双向回流 + 群内推进。
> 三期：action 完成自动播报。
> 实现入口：`src/lib/server/feishu-group.ts`（群 / 卡片基础层）、
> `src/lib/server/feishu-group-registry.ts`（成员自动注册表）、
> `src/lib/server/feishu-bridge/group-route.ts`（入向）、`group-outbound.ts`（出向）、
> `group-broadcast.ts`（自动播报）。

## 产品目标

前后端测试各自在 Flowship 上跑同一飞书项目工作项的任务。任意角色一键把产物 / 疑问分享到「需求群」：

- **首个分享者**触发建群（幂等）并 bind 到工作项 `group_type`；建群时按「成员自动注册表」
  一次带齐工作项角色成员和他们各自的 bot（没注册的人跳过、事后手动加）
- **后来者**若 bot 不在群（他没被注册表带进来）→ 引导弹窗手动加一次；加完即可直接发
- 发送人是各自的 bot（每人 Flowship 配自己的飞书自建应用，lark-cli 双身份）

## 权限边界（已实测，不可事后补救）

| 能力 | 结果 |
|------|------|
| bot 建群 | ✓ |
| 建群时带人（`user_id_list` ≤50） | ✓ |
| 建群时带 bot（`bot_id_list` ≤5） | ✓（要有同事的 app_id → 靠自动注册表，见下） |
| bot 发消息 | ✓ |
| 事后拉人 / 拉 bot | ✗（缺 scope / 不可用） |
| 用户身份发消息 | ✗ |
| 事前查群成员判 bot 在群 | ✗（`/im/v1/chats/:id/members` 不收 `member_id_type=app_id`、field validation failed；接口本身也缺 `im:chat.members:read`，实测 99991672） |
| 读群信息（`GET /im/v1/chats/:id`、bot） | ⚠️ **未实测**、推断可用——scope 与建群同族（`im:chat`），建得出群就该读得出。只用来取群名 + 识别群解散 |
| 判本人在不在群（`…/members/is_in_chat`、**user**） | ⚠️ **未实测**——是「死绑定检测」的主判据。成员列表那条路被 scope 挡死，只剩这条「问自己」的 |

> ⚠️ 上面两条打问号的能力**没有实测结论**（改动期间禁止真调飞书 API），所以实现是
> **fail-open**：查不出来就标 `membershipUnknown`、照常发，绝不因为查不了把正常分享挡掉。
> 真机第一次跑就能从日志确认走通没有——见下「需求群死绑定」。

**推论一**：**建群是唯一能带人 / 带 bot 的时机**——错过这一次，之后只能靠人在群设置里手动加。
所以建群那一刻要尽量带齐。

**推论二**：「bot 在不在群」只能**事后判定**：直接发卡、发送失败按飞书错误码映射
`bot_not_in_group`，引导用户手动加一次。

### id 换算实测表（2026-07-27、免审 scope 下——别再重走这些弯路）

建群带人要的是**我们自建 app 可用的 open_id**。meegle 侧能拿到工作项角色成员的
四种 id，但**没有一种换得出来**：

| 手上有 | 想换 open_id 的路子 | 结果 |
|--------|--------------------|------|
| `union_id`（meegle 给） | `GET /contact/v3/users/:id?user_id_type=union_id` | ✗ `user id cross tenant`——union_id 按**开发商**隔离，meegle 那个 union_id 不属于我们的自建 app |
| `lark_user_id`（meegle 给） | 同上、`user_id_type=user_id` | ✗ 缺 `contact:user.employee_id:readonly` |
| `email`（meegle 给） | `POST /contact/v3/users/batch_get_id`（emails） | ✗ 缺 `contact:user.id:readonly` |
| `user_key`（meegle 给） | —— | ✗ 飞书项目自有体系，IM 侧压根不认 |
| 姓名 / 邮箱 | `contact +search-user`、`contact +get-user` | ✗ 缺 `contact:user.basic_profile:readonly` |
| 任意 | bitable / drive 存一份对照表 | ✗ 相应 scope 也没有 |
| **本人**的 open_id | `lark-cli auth status --json` | ✓ **零 scope 零网络**（`identities.user.openId`） |
| **本人**的邮箱 | `authen/v1/user_info` / `contact +get-user` | ✗ 前者不返 email、后者缺 scope → 改从 **meegle** 拿（见下） |

公司不给审批这些通讯录 scope，所以**能换 id 的只有「本人换本人」**——这正是自动注册表
成立的前提：每个人各自登记自己，别人直接查表。

## 接入形态：需求群成员自动注册表

> 早期有过一版团队库里**手工**维护的 `members.json`，因为「得有人长期维护」被废弃；
> 现在这版是**自动**的——用户零操作，用一次群功能就自动把自己登记上去。

### 表放在哪：团队库的 `members` 数据分支（**不要开保护**）

| | |
|---|---|
| 分支 | `members`（`team-library.TEAM_LIBRARY_DATA_BRANCH`），**孤儿分支**、树里只有这一个文件 |
| 文件 | `group-members.json`（**单个文件**，不是一人一文件——email 当 key 天然去重、每个人只覆盖自己那条） |

> ⚠️ **`members` 分支绝对不能开保护**。这是整个自动注册能不能跑起来的前提：
> `main` 受保护、developer 直推被拒——注册表放 main 等于每个人的自动注册都失败，
> 表永远是空的。首次由有推送权限的人建一下（或让第一个注册成功的人自动建出来），
> 之后**别给它加保护规则、别加 push 审批**。
>
> 为什么用孤儿分支而不是从 main 拉：注册是高频自动提交（每人换机器 / 换应用都写一次），
> 挂在 main 历史上会把 skill 库的提交记录搅乱；孤儿分支跟 main 完全隔离，
> 体积和 sync 成本都可忽略。

```json
{
  "version": 1,
  "members": {
    "edison@example.com": {
      "openId": "ou_965d…",
      "botAppId": "cli_aada…",
      "name": "陈禄江",
      "updatedAt": 1769500000000
    }
  }
}
```

- key = **小写邮箱**；不像邮箱的（姓名 / user_key）一律丢弃，防污染整张表
- `openId` 缺失的条目直接跳过（建群拉不了人 = 没有存在意义）；`botAppId` 允许空
  （同事还没配自建应用，人能拉、bot 带不了）
- 序列化按 email 升序 + 2 空格缩进：多人并发写时 diff 最小、不会因遍历顺序抖出假变更

### 注册（自动、用户零操作）

| 项 | 做法 |
|----|------|
| **触发时机** | `ensureRequirementGroup`（分享 / 建群）+ `getBoundGroupChatId`（群消息回流 / 播报 gate）入口各挂一次 `scheduleSelfRegistration()`——**用到群协作的人才注册**，不新增任何用户可见步骤 |
| **调用形态** | 同步返回、后台跑（fire-and-forget）。快路径只有布尔判断 + 一次时间戳比较：本进程注册到位后直接 return；失败退避 30 分钟 |
| **邮箱来源** | `meegle user me`（没带 email 就用 `user_key` 走 `meegle user search --user-keys '["<key>"]'` 换）。**必须走 meegle**——注册表另一端（工作项角色成员）给的就是 meegle 侧邮箱，两边同源才对得上号 |
| **open_id / app_id / 姓名来源** | `lark-cli auth status --json` 的 `appId` + `identities.user.{openId,userName}`。选它不选 `getBotAppInfo().ownerOpenId` 是因为**零 scope 零网络**（只读本地凭据），而应用信息接口要「应用信息读取」权限 |
| **幂等** | 两道闸：① 先读上次 fetch 下来的 `origin/members` 快查，`openId` / `botAppId` 全同 → 直接返回，不进 git；② 真进写流程后，在**刚 fetch 的最新分支内容**上再判一次（别人 / 自己另一个实例可能已写过）→ 关死空提交窗口。`name` 漂移**不**触发写（不为一个纯展示字段推 git） |
| **写冲突** | 每轮重新 fetch 分支 → 在最新内容上按 email 逐条 merge（`updatedAt` 新者胜、相等保留 base）→ 造提交 → push；撞 non-fast-forward 就整轮重来，最多 3 轮 |
| **静默失败** | 没配 gitToken / `members` 被开了保护或没推送权限 / 网络挂 → **只 warn**，绝不 toast、绝不阻塞主流程、**不自动开 MR**（这个场景不值得）。注册不上就退回「建群只拉发起人」的老行为 |

### 铁律：绝不动主克隆的 HEAD / 索引 / 工作树

团队库主克隆（`<dataRoot>/team-library/repo`）同时被 skill 同步 / 上传 / 知识库镜像
三条链路使用，一个 `git checkout` 把 HEAD 切到 `members` 就能把它们全搞坏。所以
`writeTeamLibraryBranchFile` **全程走底层 plumbing，一次 checkout 都不做**：

```bash
git fetch origin +refs/heads/members:refs/remotes/origin/members  # 只动 ref
git show origin/members:group-members.json                        # 读旧内容（只读对象库）
git hash-object -w --no-filters -- <系统临时目录里的文件>          # 写 blob（只动对象库）
GIT_INDEX_FILE=<临时索引> git read-tree <父提交>                   # 不碰 .git/index
GIT_INDEX_FILE=<临时索引> git update-index --add --cacheinfo 100644,<blob>,group-members.json
GIT_INDEX_FILE=<临时索引> git write-tree
git commit-tree <tree> [-p <父提交>] -m <msg>                      # 造提交，不动 HEAD
git push origin <commit-sha>:refs/heads/members                    # 只动远端 ref
git update-ref refs/remotes/origin/members <commit-sha>            # 手动对齐跟踪 ref
```

- 分支不存在时 `commit-tree` **不带 `-p`** → 推上去就是孤儿分支的根提交
- 临时索引和暂存内容都放**系统临时目录**：落在工作树里会被 `git clean -fd` 删、
  或被 upload 的 `git add -A` 捡走
- 最后那条 `update-ref` 不能省：推的是裸 sha、本地没建分支，跟踪 ref 不会自动前进，
  少了它「刚写完立刻读」会读到旧内容、分支首建时更是直接读不到（单测覆盖）
- 全程不写工作树 → **不需要任何收尾恢复**，失败最多在对象库里留几个悬空对象，git gc 自己清
- 这条链**不跑**上传前的敏感扫描：写的全是公开标识符（`ou_…` / `cli_…` / 邮箱），
  不是密钥——而它们恰好会命中 high-entropy 规则，跑了必误报

**读**同样零副作用：`git show origin/members:group-members.json`，不加锁、不拉网。
新鲜度由 `syncTeamLibrary` 负责——它每轮顺带 fetch 这个分支（失败只 warn，
分支可能压根还没建，绝不能因此把整个 sync 判失败）。

### 建群时消费

```
ensureRequirementGroup（无群分支）
   ├─ getBotInfo → ownerOpenId（发起人）+ appId（本机 bot）
   ├─ meegle workitem get → role_members[].members[].email  ← 角色成员邮箱清单
   ├─ git show origin/members:group-members.json（**不主动拉网**、新鲜度靠 sync）
   └─ pickGroupCreationTargets
        ├─ user_id_list = [发起人本人, ...命中的 openId]（去重、≤50）
        └─ bot_id_list  = [...命中的 botAppId]（≤5、排除本机 bot）
```

- 发起人本人**恒在首位**：bot 建群时只有 bot 自己入群，不带人的话建群人自己都看不见这个群
- 本机 bot 从 `bot_id_list` 排除——它建群自动入群，别白占 ≤5 的额度
- 未命中的人（还没用过 Flowship 群功能）**跳过、不报错**，只在日志留一行谁被跳过了；
  角色查询挂 / 注册表读不出 / 一个都没命中 → 一律降级成「只拉发起人」（老行为）
- 一个都没命中时**不塞空的 `bot_id_list`**，载荷保持干净

### 后来者仍要手动加 bot 的情况

同事在你建群时还没注册过（注册表里没有他）→ 他首次分享会走老链路：

| 角色 | 动作 |
|------|------|
| 建群人 A | 点分享 → 自动建群（A + 注册表命中的人和 bot）+ bind 工作项 |
| 未命中的 B | 点分享 → 发卡失败（230002 一族）→ 409 `bot_not_in_group` → 引导弹窗（bot 名 + 复制 + 三步）→ 群设置里加 B 的 bot → 点「已添加，重试发送」原样重发 |

引导弹窗要给**准确**的机器人名：`GET /open-apis/bot/v3/info` 的 `app_name`
（免审基础 scope、就是群成员列表 / 添加机器人搜索框里显示的那个名字，进程内缓存）。
取不到依次退应用信息接口的 `appName`、`app_id`。

## 架构

```
UI / Agent
   │
   ├─ POST /api/tasks/:id/share-to-group
   └─ MCP share_to_group（flowship-task server）
            │
            ▼
   shareToRequirementGroup(task, input)
            │
            ├─ ensureRequirementGroup
            │     ├─ scheduleSelfRegistration（后台把本机身份写进注册表、静默失败）
            │     ├─ meegle workitem get group_type
            │     ├─（有群、显式分享）inspectBoundGroup：取群名 + 判本人还在不在
            │     │        → 不在 → owner_not_in_group / group_unreachable（前端引导重建）
            │     ├─（无群 / 用户确认重建）角色成员 email → 注册表反查 → lark POST /im/v1/chats
            │     │        （user_id_list + bot_id_list）+ meegle bind
            │     └─ 并发：bind 前再查，收敛到已有 group_id（重建时不认那条失效 id）
            ├─ format=card（默认）：sendInteractiveCardToChat
            │     └─ kind=artifact 再 sendFileMessageToChat（全文 md）
            ├─ format=post：sendPostMarkdownToChat（mentions 拼成 `<at user_id>`）
            └─ 发送失败：isBotNotInGroupSendError（230002 一族）
                   → 抛 bot_not_in_group（带 botLabel）；其它错误照旧 lark_error
```

### 复用（不要另起 HTTP 客户端）

| 能力 | 来源 |
|------|------|
| lark-cli 队列 / token / `larkApi` | `feishu-bridge/lark-api.ts` |
| 建卡实体 `createCardEntity` | 同上 |
| 群聊发卡 `sendInteractiveCardToChat` | 同上（本期新增薄封装） |
| 群聊发文件 `sendFileMessageToChat` | 同上（临时 md + cwd 相对路径，见「内容形态」） |
| 群聊发 post markdown `sendPostMarkdownToChat` | 同上（`format: "post"` / 提测 @） |
| 建群 / bot 展示名 | `createImChat` / `getBotDisplayName`（降级链单一来源） |
| meegle 串行队列 + 错误三态 | `meegle-cli.ts` |
| `group_type` 读/bind、工作项名 | `fetchWorkitemGroupType` / `bindWorkitemGroup` / `fetchWorkitemName` |
| 工作项角色成员（邮箱清单） | `fetchWorkitemRoleMembers`（复用 `fetchWorkitemDetail` 的全量查询 + 进程缓存） |
| 本人邮箱 / 本机 lark 身份 | `fetchMyEmail`（meegle）/ `getLarkLocalIdentity`（`auth status`） |
| 成员注册表读 / 写 / 挑人 | `feishu-group-registry.ts` |
| 群名 / 本人在不在群 | `lark-api.fetchChatInfo` / `probeSelfInChat`（死绑定检测两层探针） |
| 数据分支读 / 读改写 + 冲突重试 | `team-library.readTeamLibraryBranchFile` / `writeTeamLibraryBranchFile`（git 管道单一源，写入口进仓锁） |

### 瞬时传输失败的安全重试（`runLark` 单一闸）

实测报文：`API call failed: Post "https://accounts.feishu.cn/oauth/v3/token": EOF`
（同族还撞过 `ECONNRESET`）——挂在**取 token 那一跳**，业务请求一个字节都没发出去。

闸在 `runLark`（所有 lark-cli 调用的唯一收口），最多重试 2 次、退避 300ms → 900ms：

| 条件 | 重试？ |
|------|--------|
| 瞬时传输错误 + **幂等命令**（`api GET` / `auth status`） | ✓ |
| 瞬时传输错误 + 写操作，但失败在 **取 token 那一跳** | ✓（还没发出去、零副作用） |
| 瞬时传输错误 + 写操作（发消息 / 建群 / 建卡） | ⛔ **一次都不重试** |
| 业务错误（权限 / 参数 / bot 不在群） | ⛔ 重试多少次都是同一个结果 |

⛔ 那条「写操作不重试」是硬的：请求已发出、响应回来路上断了时，成功与失败**无法区分**，
盲目重试就是群里两张重复卡、工作项两个孤儿群（本仓踩过）。

「什么算瞬时」的口径下沉到 `types.isTransientLarkError`（**单一来源**，设置页探测的
「网络异常、点重试」判定也用它）——它连 `LarkApiError.raw` 里的原始 stdout / stderr
一起看：CLI 解析不出 JSON 时 message 只剩一句「Command failed」、`EOF` 全在 raw 里。

**依赖方向**：`feishu-group-registry` 读写都**动态** `import("./team-library")`——
建群链路很热，不能把那张重依赖图静态挂上去；git 命令一条都不在 registry 里自己拼。

## `group_type` 读写协议（不对称）

| | 判别键 | 示例 |
|--|--------|------|
| **读** | `value` | `{ value: "bind", label: "绑定现有群", group_id: "oc_xxx" }` |
| **写** | `type` | `{"type":"bind","group_id":"oc_xxx"}`（整段 stringified 进 `field_value`） |

- `auto` / `bind`：通常有 `group_id` → 直接用
- `disabled`：无群 → 走建群 + bind

命令：

```bash
meegle workitem get --work-item-id <id> --fields '["group_type"]' --project-key <key>
meegle workitem update --work-item-id <id> --project-key <key> \
  --fields '[{"field_key":"group_type","field_value":"{\"type\":\"bind\",\"group_id\":\"oc_xxx\"}"}]'
```

## 姓名从哪来

> 注册表里的 `name` **只给排障看**，不参与群内姓名解析——它只有「用过 Flowship 群功能
> 的人」，覆盖不了群里说话的所有人，不能当姓名字典用。

| 场景 | 来源 |
|------|------|
| 群消息发起人（打字 @bot） | 事件自带 `sender_name`；缺则 `群成员`（`GROUP_MEMBER_FALLBACK_NAME`） |
| 群答题卡点按钮 | 只有 `open_id`、事件不带姓名 → 一律 `群成员`（换姓名要通讯录权限、公司不给审批） |
| 卡片 footer 署名 | `resolveShareSenderName()`：meegle `user me` 姓名 → bot 应用名 |

## 需求群死绑定（2026-07-28 用户实测 P0）

**症状**：用户退掉了那个需求群（同族：被踢 / 群解散 / 换群），但工作项上的 `group_type`
还 bind 着它，**bot 仍在群里** → `ensureRequirementGroup` 第一步读到 bind 就直接复用 →
`sendCard` 成功 → 前端提示「分享成功」→ **用户什么都看不到**。

「bot 在不在群」那套**事后判定**在这里失效：发送成功恰恰是症状本身。所以
「**本人**在不在群」必须**事前**判——`inspectBoundGroup`，复用绑定前跑：

| 层 | 调用 | 干什么 |
|----|------|--------|
| 1 | `fetchChatInfo`（bot） | 取真实群名（回执要用）；飞书明说「群不存在」→ `group_unreachable` |
| 2 | `probeSelfInChat`（**user**） | 本人在不在群。`false` → `owner_not_in_group`（带群名 + chatId） |

- **只有显式分享开这道闸**（`verifyOwnerMembership: true`：API route / MCP）。
  群内推进回执和自动播报**不开**——那些的读者是群里的人，属主在不在不影响该不该发，
  开了反而把同事的产物挡掉；而且它们跑在热路径 / 后台，不该白付两次 CLI 往返。
- **查不出来时不猜**（scope 不够 / 网络抖 / user 身份没登录）：标 `membershipUnknown`、
  留一条 warn、**照常发**。宁可漏检也不能把正常分享挡掉——那两个接口的可用性还没实测。
- 「群没了」的判定**只认正面信号**（报文明说 chat not found / 不存在 / 已解散）。
  缺 scope、网络抖、bot 被移出群都会让读群信息失败，但它们各有各的补救路径
  （补权限 / 重试 / 把机器人加回去）——误判成「群没了」就是诱导用户白建一个孤儿群。

### 重建出口

没有它用户是**完全卡死**的：死绑定会让每次分享都静默发进他看不见的群。

```
分享 → 409 owner_not_in_group（chatId + chatName）
     → 前端 useDialog().confirm「你已不在「XXX需求群」／重建一个需求群再发？」
     → 确认 → 原样重发、body 带 recreateFrom = 那条失效 chatId
     → ensureRequirementGroup 跳过复用 → 建群 + bind 覆盖
```

`recreateFrom` 在**两处**被认，少一处重建就白做：

1. 复用快路径对它视而不见（否则原地又复用了那条死绑定）
2. bind 前的并发收敛不把它当「别人抢先建好的群」（否则收敛回死绑定、白建一个群）

只对「**当前仍是这一条**绑定」生效：期间已被换成别的群 → 当普通复用、照常校验，不重建。
真有别人抢先 bind 了**另一个**群 → 并发收敛照旧生效。
重建**没有 agent 入口**——`recreateFrom` 只由用户在 UI 引导里确认后回传。

## 幂等 / 并发策略

1. 读 `group_type` → 已有 `group_id`（auto/bind）→ **过一道死绑定校验**（显式分享才跑，
   见上）→ 直接返回，`created=false`
2. 无群 → bot `POST /im/v1/chats`（群名 `<需求名>需求群`、`user_id_list` = 发起人 +
   注册表命中的角色成员、`bot_id_list` = 命中者的 bot；一个都没命中就只有发起人）
3. **bind 前再读一次**
   - 若已被别人 bind → 用别人的 `group_id`，本机新建群记 `console.warn`，`created=false`
   - 否则 `workitem update` bind 本机群，`created=true`
4. 分享时直接发卡（无任何事前 bot 检测）；发送失败按飞书错误码判定——
   230002（bot 不在群）一族命中即返回 `bot_not_in_group`（带 `botLabel`），
   码集合与报文关键词兜底见 `feishu-group.isBotNotInGroupSendError`

## API / 工具契约

### `POST /api/tasks/[id]/share-to-group`

```json
// request（recreateFrom 只在用户确认重建时带）
{
  "kind": "artifact" | "message" | "question",
  "title": "可选",
  "content": "正文",
  "links": [{ "label": "MR", "url": "https://..." }],
  "recreateFrom": "oc_失效的群"
}

// success 200（docMessageId 只有 kind=artifact 才有；缺失 = md 文件没发出去、卡片仍已发）
// chatName = 真实群名（读到才有）；membershipUnknown = 没查出本人在不在群、已照常发
{ "ok": true, "chatId": "oc_...", "chatName": "登录优化需求群", "messageId": "om_...",
  "created": false, "membershipUnknown": true, "docMessageId": "om_..." }

// error（例）409
{
  "error": "群里还没有你的机器人「XX」，在群设置里添加一次即可",
  "code": "bot_not_in_group",
  "botLabel": "XX",
  "chatId": "oc_..."
}
```

三个 **409 = 有引导可走的预期内失败**（不刷 error 日志）：`bot_not_in_group`
（手动加机器人）、`owner_not_in_group` / `group_unreachable`（重建需求群，附
`chatId` + `chatName`）。其余错误码分流照旧（400 / 401 / 403 / 502）。

**回执带群名**：成功 toast 从干巴巴的「已分享到需求群」改成「已发到「XXX需求群」」
——这一条本身就是死绑定的第一道自查，发错地方用户当场就看得出来。
`chatName` **只放真实读到的名字**：按 `<需求名>需求群` 反推的名字在群改过名时是错的，
而「看着像对的群名」比没有群名更容易让用户放下戒心。

`botLabel` 一路透传到 UI（route / MCP 都带）：前端 `useShareToGroup` 收到
`needManualBotAdd` 就弹 `BotAddGuideDialog`——机器人名 + 复制按钮 + 三步指引 +
「已添加，重试发送」。**重试原样重发同一份内容**（hook 里记着载荷），所以
`runShare` 的 promise 要等引导走完才结算，调用方 `await` 到 `true` 才关自己的确认弹窗。

### MCP `share_to_group`

参数：`task_id`、`content`、可选 `title` / `links` / `kind`（默认 `message`）。  
**describe 铁律**：仅用户明确要求分享或 playbook 编排时调用，禁止自行滥发。  
describe 里要同步说清内容形态（`artifact` 走 md 文件不截断 / 其余进卡片截 2000、
`docMessageId` 缺失不要重发）——工具 describe 是 agent 的第二指令源，别跟实现漂移。

## 内容形态（2026-07-27 用户拍板改版）

`shareToRequirementGroup` 按 **format** 分流（发到需求群的唯一收口）：

| format | 群里长什么样 | 谁在用 |
|------|-------------|---------|
| `card`（默认） | 互动卡片；`kind=artifact` 再跟一条 md 文件 | UI 分享 / MCP `share_to_group` / 自动播报 / 群内推进产物 |
| `post` | 一条会渲染的 IM markdown；`mentions` 拼成 `<at user_id>` | 提测 @（`notify_group_testers`） |

`card` 再按 `kind` 分流：

| kind | 群里长什么样 | 正文去哪 |
|------|-------------|---------|
| `artifact`（整份产物） | **瘦卡片 + 一条 md 文件消息** | 卡片**不放正文**，全文进 md 文件、不截断 |
| `message` / `question`（选中段 / 疑问 / 进展） | 一张卡片 | 进卡片 markdown、截断 2000 |

卡片公共结构：

- header：需求名（+ 可选 title）+ kind 徽标色（产物 blue / 消息 wathet / 疑问 orange）
- 按钮：`links` + 自动「查看工作项」（`task.feishuStoryUrl`）
- footer：`来自 <本机用户名> · Flowship`（署名辨识；姓名优先 meegle `user me`，否则 lark `auth status` 的本人姓名）

**为什么产物不放正文**：原来把 artifact 全文截断 2000 塞进卡片、群里直接刷屏；
改摘要（~200 字）又「既说不清内容又占版面」。结论是卡片只当索引（需求名 · action 标题 +
MR / 工作项按钮 + 署名），正文交给 md 文件——点开即看、还能转存。

### md 文件消息

- 文件名 = `<需求名>-<action 标题>.md`（**群里显示的就是它**，所以要一眼看出是哪个需求的哪一步）；
  非法字符（路径分隔符 / 换行 / `:*?"<>|`）洗成 `-`、主体截 60 字、洗空退 `产物.md`
- 顺序固定**先卡片后文件**：卡片是身份信息、先给上下文
- **文件发失败不影响卡片**：只 warn 一条「完整产物发送失败」、整体仍返回成功
  （卡片已经在群里了，抛错会让用户以为没发出去、重复点分享攒重复卡）；
  成功时返回值多一个 `docMessageId`，缺失即代表没发出去

⚠️ **lark-cli 的 `--file` 只吃 cwd 相对路径**（绝对路径和 `..` 直接被拒、`--help` 明写）。
所以 `sendFileMessageToChat` 的做法是：在 `<dataRoot>/feishu-bridge/share-doc/<一次性 id>/`
下按展示名落一个临时文件 → 以该目录为 cwd 传 basename → 发完（含失败）删整个子目录。
一次一个子目录是为了「两个任务同时分享同名产物」不互相盖文件。

---

# 二期：群内双向回流 + 群内推进

复用 p2p 桥接（`feishu-bridge/`）的全套基建：inbound consumer、`parseInboundContent`
（图 / 文件下载）、`card.action.trigger` 按钮回调、pendingAsk 先到先得语义、
`chat-inject` / `question` 注入链。**没有新起任何通道。**

## 链路

```
im.message.receive_v1（群）
   │  router.routeInboundMessage 判 chat_type
   ▼
group-route.routeGroupInboundMessage
   ├─ 0) 没 @ 过任何人            → 忽略（零 IO 预筛）
   ├─ 1) 发送人是机器人自己        → 忽略（防自问自答成环）
   ├─ 2) 没 @ 本机 bot            → 忽略（防刷屏）
   ├─ 3) chat_id 反查不到本机任务  → 群里回「本机没有关联此需求的任务」
   ├─ 4)「推进」（无 action 名）   → 仅属主 → 回 action 选择卡（属主点按钮开跑）
   ├─ 5)「推进 <action>」          → 仅属主 → advanceTask
   └─ 6) 其它文本                  → pendingAsk ? 答题（任何人）
                                     : 任务在跑 ? 拒（不建登记）
                                     : 消息注入（非属主强制只答疑）

task 事件流（全局 tap）
   ▼
group-outbound.handleGroupOutboundEvent
   ├─ ask_user_request  → 答题卡发群（开关：问题同步到需求群）
   ├─ assistant_delta   → 攒本轮回答
   ├─ done              → question：回答 @ 提问人发回群
   │                      advance：只在 action 已落终态时收口（见下）
   └─ task / action     → advance：action 落终态 → 产物走 share 卡发回群
                          （开关：群内推进结果回群）
```

### 推进的收口判据是 action 状态、不是 turn 结束

`done` 是 **turn 级**语义：agent 跑到一半调 `ask_user` 就会自然结束 turn 并发一帧
`done(ok=true)`，此时 artifact 根本还没写。曾经按 done 收口，后果三连——产物读不到 →
回落成 agent 半程旁白 → 以「产物卡」发进群，顺手把产物卡防重坑占死，**真产物再也
发不进群**（第五轮双审 P1-A、同族第四次投影）。

现在 advance 登记只认 action 的终态：

| action 状态 | 收口 |
|---|---|
| `running`（含等 ask 答案） | **不 take**，登记原样挂着等下一帧 |
| `awaiting_ack` / `completed` | 发产物（无 artifact 则按文本回旁白、不冒充产物卡） |
| `cancelled` / `error` | 发「推进没跑成功」 |

后置检查落 `awaiting_ack` 时 publish 的 `task` / `action` 帧就是那「下一帧」。
唯一不看 action 状态的出口是 `done(ok=false)`：run 真挂了 / 被停时有的失败路径来不及
标 action，不收口这条登记就只能等到期收口协议来处理、群里白等一轮租约。

「ask 一直没人答」不会泄漏、也**不会**被租约摘掉：advance 登记走租约 + 到期收口协议
（到点先问一句 action 状态、仍 `running` 就续租），见下「推进登记的保活策略」。
走 TTL 直接摘的只有 `question` 登记。

## 路由协议：chat_id → 本机 task

飞书没有「按群反查工作项」的开放接口，所以反查方向是**本机任务 → 它绑定的群**：

1. 命中缓存（`chatId → taskId`，10 分钟）→ 直接用（仍确认 task 还在，防已删）
2. 未命中缓存（60 秒负缓存）→ 扫本机任务：有 `feishuStoryUrl` 且非终态、按
   `updatedAt` 倒序取前 20 条 → 逐个 `getBoundGroupChatId`（只读 `group_type`、**绝不建群**）
3. 扫描顺带缓存所有查到的 (群, task) 对——之后别的群消息大概率直接命中

负缓存是必需的：无关群的刷屏否则每条都触发一轮全量 meegle 扫描。

## @ 过滤（三层，从便宜到贵）

| 层 | 判据 | 成本 |
|----|------|------|
| 0 | `mentions` 空且正文无 `@` | 零 IO（群里绝大多数闲聊在这层被筛掉） |
| 1 | `mentions` 命中**机器人自己的** open_id（`GET /open-apis/bot/v3/info`，缓存） | 一次 CLI 往返 / 进程 |
| 2 | `mentions` 缺失（CLI 扁平 schema 不一定下发）→ 正文字面 `@<应用名>` | 零 IO |

⚠️ 机器人被 @ 时 mention 里的是**机器人自己的 open_id**，不是 `BotAppInfo.ownerOpenId`
（那是应用 owner = 本人）。两者别混。

`bot/v3/info` 一次调用喂两个用途（`fetchBotSelfInfo` 单缓存）：`open_id` 给 @ 判定、
`app_name` 给「引导用户手动加 bot」的展示名。

## 身份门控

**口径：读 / 答疑对全群开放，写路径只有任务所有者本人能触发。**

| 动作 | 谁可以 | 说明 |
|------|--------|------|
| 提问 / 回灌（**只答疑**） | 群里任何人 | 跨角色协作的意义所在 |
| 答 ask_user | 群里任何人 | agent 主动问的、先到先得；答案记 `meta.answeredBy` |
| 改产物重交卷 / 唤醒全权限 agent | **仅 `sender_id === ownerOpenId`** | 非属主消息强制 `restrictToQuestion`（见下） |
| **推进 action**（打字 / 点选择卡） | **仅属主本人** | 起 agent、烧 API 额度、改任务状态 |

非属主推进（打字或点选择卡按钮）→ 回「仅任务所有者可推进」，不起 agent。

### 非属主消息的 `restrictToQuestion`（写路径硬拦）

「@bot 说句话」也能驱动写：task 模式下这条消息会走 `handleTaskQuestionInject`，
产出在 `awaiting_ack` 时它就是原 revise 语义（snapshot 产物 → action 打回 running →
agent 改完重新交卷），会话断了还会**唤醒**一个全权限 agent 原地续。所以群来源且
`sender_id !== ownerOpenId` 的普通文本一律带 `restrictToQuestion: true`：

| 拦点 | 效果 |
|------|------|
| **不复用活会话** | 有活会话也不 `agent.send`（那是属主带 playbook + 系统工具 + 文件 / shell 权限的 agent） |
| 不认 `ackContext` | 不 snapshot、不把 `awaiting_ack` 打回 running（不触发重交卷） |
| `canResume = false` | 会话断了也不 resume 唤醒全权限 agent |
| **落独立旁路** | 恒走 `restricted-question.startRestrictedGroupQuestion`：受限 prompt（只答疑、禁止新建 / 修改 / 删除文件、禁止有副作用的命令、**不注入**属主版那句「小改动直接改」）、且与 task 运行状态机完全解耦（见下） |
| 正文前缀 | `[群消息·来自 XX（非任务所有者）]——只答疑、不执行修改类指令`（属主消息不加） |

前四条是服务端硬拦、不依赖模型自觉；前缀只是给 agent 的额外提示。
答 `ask_user` 不受限——那是 agent 主动问的，跨角色答题正是本功能的意义。

⚠️ 「一次性 agent = 只答不动手」这句自 V0.13.x 起**只对受限旁路成立**：属主自己的
`startOneShotQuestion` 是能直接改小改动的（用户拍板「纯答疑限制太死」）。两条通道
因此彻底分家，别再合并回一个入口。

⚠️ 受限 prompt **不得复用 `buildAgentMessage({kind:"user_message"})`**：那个封装会追加
一段给属主写的行为约束（「…**修改要求**才动手改…不要调 submit_work…」），塞进只读
prompt 就是同一段指令里既写「禁止改」又写「才动手改」，只读招牌当场作废。受限旁路
走 `buildReadonlyUserMessage`（只有 `[USER_MESSAGE]` 抬头 + 正文 + 附件段），并且
「# 边界（硬约束）」永远排在 prompt 最后一段。

### 受限旁路与 task 运行状态机**完全解耦**

`restricted-question.ts` 是一条旁路，不是这个 task 的一次 action run：

| 不碰 | 为什么 |
|------|--------|
| `task.runStatus` | 顶栏「停止」键只看 `runStatus === "running"`（`isStopButtonVisible` 单一源）。群答疑写了 running，停止键就在答疑期间冒出来；点下去走 `stopTaskAgent` 核弹路径——running / `awaiting_ack` 的 action 一律标 cancelled + 关属主会话，审阅中的 plan/review 直接被取消 |
| `runningTasks` | 不占位 = 不进 advance / send 的互斥判定，也不会被 `cancelTaskRun` 顺手带走 |
| `agentSessions` | 独立实例、不落会话锚点、答完 close——不会被后续「续用推进」误当正式会话 |
| action 状态 | 非属主的一句话不该改产物、更不该重交卷 |

因此它能与属主的活会话并行跑（action 交卷后会话是刻意保留的，而那正是产物刚播报
进群、同事最可能回话的窗口）。

它唯一的登记是 task-stream 的 `registerRestrictedQuestion` 轻量表，服务三件事：

1. **终态叫停**：DELETE / `finalizeTask` 要删 worktree → `cancelRestrictedQuestions(taskId)`
   （它不在 `runningTasks` 里，`cancelTaskRun` 够不着）
2. **群侧串行**：`isTaskBusyForGroupMessage`（普通消息）与 `checkTaskAdvanceable`
   （群内推进 / 选择卡）都拒在飞——同一 worktree 上并排起几个 agent 既烧额度又抢 IO，
   群里也只有一条对话线索。⚠️ 只在**群入向**这一侧串，不是 task 运行态判定
3. **UI 运行态信号**：表变化即 publish `restricted_run` 帧（active = 表里还有没有），
   `watch-task` bootstrap 也按表补一帧。任务详情页把它并进 `isRunning`——否则旁路
   agent 跑着的长 shell / 子代理写进事件流后，会因 `runStatus !== "running"` 被
   `coerceStaleRunningTools` 判成脏数据、渲染成灰色「已中断」（第四轮双审 P1-2）

⛔ 别把这张表接回 runStatus / 停止键 / **app 侧** advance 准入——那就是又耦合回去了。
（`restricted_run` 是纯 UI 帧、不进 `task.runStatus`；群入向那两道闸只挡群消息。）

**收口只有一个函数**：`settle(ok, errorText?)`，幂等、任何出口（成功 / 失败 / 取消 /
finally 兜底）都只经它发一次 `done`。`done` 是群出向 tap 回群 + 摘掉回群登记的唯一
触发点，所以它**无条件 publish**（不挂 lease）；error 事件反过来走 lease（任务都删了
就别再往盘上写）。解耦之后没有 `runStatus` 要回滚，收口面就只剩这一件事。

⚠️ 已知边界：chat 模式任务走 `handleChatReplyInject`（没有 action / artifact、无 revise
语义），非属主消息只有前缀降信任、没有服务端硬拦。chat 任务几乎不会绑需求群
（反查要求 `feishuStoryUrl` 非空），真出现再补。

## 群内推进命令

- `推进` / `推进 <action>`（允许 `/推进` 前缀）
- **不带 action 名 = 回一张 action 选择卡**（用户拍板「每个人的 action 和顺序都
  不一样，必须能选」——原「按最近 action 顺推下一步」的默认推断已删）：
  - 按钮数据源 = **推进弹窗同款**（`advance-options.listAdvanceOptionGroupsForTask`：
    `listCustomActions` 过滤链 + `actionLayout` 顺序显隐 + `groupAdvanceActions`
    分组序；日常任务只列自定义组）
  - 按钮 ≤20 个（`GROUP_ADVANCE_MAX_BUTTONS`）、超出截断并提示去应用内选；
    没有可推进项回文本引导去能力页
  - 按钮 value：`kind: "group_advance"` + taskId / chatId / actionKey / **pickId**
    （出卡时生成的一次性标识）+ label 快照
  - 点按钮 → card.action.trigger → `group-route.handleGroupAdvancePick`：
    属主校验（非属主回「仅任务所有者可推进」）→ pickId 占坑（**同一张卡二次点击
    回「已在跑 <label>」**、启动失败退坑允许重选）→ 开跑 → 回「已开始跑 <label>」
- 带名字直推：内置别名（type 关键字 `plan` / 中文全称 `出方案` / 中文短标 `方案` /
  英文标 `Plan`）优先；不中再按可推进清单对**自定义 action 的 label / skill 名**
  模糊匹配（精确 → 唯一包含命中，多个命中按没认出处理）
- **模型沿用 `task.model`**（群里没法选模型），任务没记过才回落设置页默认
- 受理即回「已开始跑 <label>」；`runStatus=running` 时拒绝重复推进

## 竞态语义

| 场景 | 处理 |
|------|------|
| app 内答题 vs 群内答题 | 先到先得（复用 pendingAsk 一次性提交）；后到的卡片按钮置「已失效」+ 群里 @ 他回「这个问题已经有人回答了」 |
| **答题 vs 用户直接发新消息（跳过）** | 同一个仲裁者：谁先把 pendingAsk **原子摘走**谁赢（`takePendingAskIf`）。答赢 → 跳过认领落空、一个字都不写；跳过赢 → `ask-reply` 入口的 `isAskSkipped` 闸 409。登记为空时靠 `wasAskTakenRecently` 区分「答题链在飞」与「重启后的孤儿 ask」——前者放手、后者才按事件收口 |
| 群里两人同时点选项 | `card.action.trigger` 走 inbound 的 card-action 串行链，第二次必然看到 pending 已清 → 走失效分支 |
| **卡片点击 vs 群里打字**答同一题 | 两条**独立**串行链（card-action 链 / 入向消息链）不互相排队 → `injectPendingAskText` 入口 `takePendingAsk` **同步摘走**，后到的直接 `no_pending`；投递失败按条件放回（槽位已被新提问占住就不放） |
| 提问后 pending 刚被答掉 | `injectPendingAskText` 返 `no_pending` → 降级成普通消息注入（不丢消息） |
| 同一 task 连着 @ 两句 | run 在飞时后到的**直接拒**（回「任务正在跑、等这一轮结束再问」）、连登记都不建；旁路答疑在飞时回的是「群答疑还在跑、等它答完再来」（它不写 runStatus、任务此刻显示空闲，复用前一句会让人对着 idle 任务干等）；任务闲时属主通道后到的覆盖先到的（只回最后一句的语境） |
| 登记被覆盖后本轮失败 | 登记带**不可复用 token**：失败只回滚自己那次（`restoreGroupReply`）——自己那条已被摘走就什么都不做，自己覆盖过谁就把谁原样放回（连同已攒的回答文本） |
| **属主 run 与旁路答疑并行** | 登记记死「认哪一路 run」（`runTag`），属主 run 的 delta / done 进不了同事的登记，反之亦然——见下「token 化投递协议」 |
| advance 起 agent 前的窗口 | 登记抢在 `advanceTask` 之前、action id 事后按 token 补记；**补记之前一律继续等**（⛔ 不退回 `task.currentActionId` 顶包——那多半是上一轮已交卷的 action，一帧 `task` 就能把别人的旧产物当本轮结果发进群）；启动失败按 token 回滚 |
| **推进跑到一半 agent 问问题、群里有人作答** | 那条答案属于同一轮推进 → 属主那一格 **advance 不被 question 顶掉**（`rememberGroupReply` 返 `null` = 本次不另开登记），结果仍由推进的产物卡承载 |
| 上一轮推进还在等 ask、属主又喊「推进 <别的>」 | 新一轮顶掉老登记（群里要的是最新那轮），但顶掉后 `@` 上一轮的发起人交代一句——静默丢就是他在群里干等 |
| chat 型任务注入排队（202） | 这条消息**没有** run 会开跑 → 摘掉登记、群里只回受理回执（留着就会被下一轮无关的 done 收走、把别人的回答 @ 给他） |
| 旁路答疑在飞时属主喊「推进」 | `checkTaskAdvanceable` 拒（回「群答疑还在跑、等它答完再来」）；打字直推与选择卡按钮同一道闸 |
| 推进选择卡重复点击 | pickId 占坑表（`group-shared`、同步占坑零 await）：第一下开跑、同卡后续点击回「已在跑 <label>」；启动失败退坑、同卡允许重选 |
| 推进收口 vs 自动播报 | 同一 action 的产物卡两条链都想发 → 共用 `group-shared` 那张防重表、**先占再发**，谁先占谁发（见三期「防重」）。让位预筛 `hasGroupAdvanceReplyFor` **只认 actionId 精确相等**——曾经把「还没补记 actionId」也算让位，那个窗口里任意 action 的播报都被静默吞掉 |

### 回群登记的 token 化投递协议

同族问题冒头三次（B 的 409 清掉 A 的登记 / 属主 run 的 done flush 掉同事的登记 /
属主的 delta 攒进同事的答案）之后，按本仓铁律停止逐分支打补丁、收敛成一个协议：
**每条登记绑一个不可复用 token，并记死自己在等哪一路 run（`runTag`）**。

| 通道 | `runTag` | 谁来回答 |
|------|----------|----------|
| `owner` | `null` | 属主主链：task run / 活会话 / one-shot / stop 补发的 done——这条链上的 envelope **不带** `origin` |
| `restricted` | = 自己的 token | 非属主的只读旁路答疑 run，起 run 时把 token 交给它，它 publish 的每条 envelope 都带 `origin = token` |

- **攒回答（delta / assistant_message）与 flush（done）只认 `origin === runTag` 的那一路**：
  属主 run 与多位同事的答疑 run 可以同时在飞，各回各的
- 属主通道每 task 仍只一格（后到覆盖先到、`previous` 随凭据带走供回滚），
  但**在飞的 `advance` 不被 `question` 顶掉**（推进中途的 ask 答案属于同一轮推进，
  顶掉就是拿一句旁白换掉整份产物卡）；
  旁路通道**并存**，容量上限 `GROUP_REPLY_MAX_PER_TASK`（超限只丢**非 advance** 的最老那条），
  租约 `GROUP_REPLY_TTL_MS`（2h）随访清理——advance 到点不摘、走到期收口协议
- **摘 advance 登记 = 群里再也收不到这轮产物**，所以四条清理链一条都不许对它静默动手，
  见下「推进登记的保活策略」
- 事件身份的贯通链：`rememberGroupReply → handle.runTag →
  handleTaskQuestionInject(restrictedRunTag) → startRestrictedGroupQuestion(runTag) →
  handleSdkMessage / writeOwnedEventAndPublish / settle 的 origin`。
  旁路 run **永远**带 origin（调用方没给就自生成），绝不冒充属主主链
- 群里有待答提问时先按 owner 登记（答案要送进属主活会话）；`no_pending` 竞态落回
  旁路时用 `retagGroupReplyToRestricted` 改挂，否则那轮回答找不到登记

踩过的三起事故：
1. A 提问注入成功、agent 开跑 → B 在窗口内再 @ → B 的登记覆盖 A → B 的注入被 409 拒 →
   B 裸删 entry → **A 的回答再也回不了群**（→ token 条件回滚）
2. 同事的答疑在飞、属主同时在 app 里推进 → 属主 run 的 done 把同事的登记 flush 掉 →
   **同事收到属主的产物**，真答案随后扑空、群里永久无答（→ runTag 投递）
3. 属主 run 的 delta 攒进同事那条登记 → **两个人的回答混成一段**（→ 同上）

⚠️ 已知边界（有意为之）：属主主链是**一条通道**、不是 per-run token——task-runner /
chat-runner / stop 有二十来个 done 出口，全量贯通 run id 的收益不抵改动面；而 task
状态机本身保证同一 task 同时只有一个属主 run，单格够用。真正会并行的是旁路 run，
它按 token 精确投递（白名单方向：旁路事件永远带 origin、绝进不了属主那格）。

### 推进登记的保活策略（四条清理链口径表）

固定策略（`advanceResultToGroup=true` + `autoBroadcast="off"`）下，推进登记是
「群内推进 → 群里拿到产物」的**唯一**出向路径。摘掉它 = 群里永久静默（既没有产物卡、
也没有失败回执），所以**四条**清理链都得对 `advance` 区别对待（这张表与
`group-shared.ts` 文件头那张是同一份口径，改一处要同步另一处）：

| 清理链 | 对 `question` | 对 `advance` |
|--------|---------------|--------------|
| 租约到期（`pruneTask`） | 直接摘 | 只推给出向钩子判定 |
| 属主单格覆盖（`rememberGroupReply`） | 后到覆盖先到 | 不被 question 顶掉；被**下一轮 advance** 顶掉时回群补一句（见下） |
| 容量上限（同上） | 丢最老的 | **永不挤掉**（只丢非 advance 的最老那条） |
| 失败回滚（`restoreGroupReply`） | 租约过期就不放回 | **无条件放回**——放回后到期自有收口协议接手，不在回滚路径上顺手静默摘 |

到期判定归 `group-outbound.reviewExpiredGroupAdvance`（group-shared 是同步纯状态、
读不到 action 也发不了消息）：action 仍 `running` → **续租**；已终态 → 补一次正常收口；
action 查不到 → 摘登记 + `@` 一句「等太久没拿到结果、去 Flowship 看事件流」。
判定本身失败就什么都不做，租约里留了 `GROUP_ADVANCE_EXPIRY_REVIEW_MS` 的宽限、下轮再问。
它**自己判一次桥接总开关**：钩子是 `hasGroupReplies` 那句同步预筛里的 prune 触发的，
而预筛排在 `handleGroupOutboundEvent` 的开关判定之前——不判就会在桥接关掉后仍往群里发回执。

**被新一轮推进顶掉**时（属主单格、advance 覆盖 advance）由 `group-route` 给上一轮的
发起人 `@` 一句「上一轮推进已被新一轮取代…」。两个位置约束：只在 `advanceTask` 真起来
之后发（启动失败会 `restoreGroupReply` 把老登记原样放回、那就没被取代），且「推进结果
回群」关掉时不发（与到期回执同口径）。可达剧本不极端：advance#1 中途 `ask_user` 时
action 仍 `running`、`runStatus` 是 `awaiting_user`，两道准入都放行，属主接着喊
「推进 <别的>」就撞上。

两起同族事故（都在真实剧本里、都不极端）：
1. 群里推进 → agent 中途 `ask_user` → 人开完会 / 隔夜才在 App 里答：这段纯等待期
   一条流事件都没有、墙钟照走，2h 后任意 peek / has / remember 触发的 prune 把登记
   splice 掉 → action 后来跑完，群里什么都没有（**「有 delta 就续租」治不了纯等待**，
   它只能当顺手的加固、不能单独当修法）
2. 推进占 1 格 + 旁路答疑攒到 8 条 → 第 9 条的裸 `shift()` 挤掉最早的推进登记 →
   同样静默无产物（前门「advance 不被 question 顶掉」挡住了，后门还开着）

## 群答题卡

`group-ask-card.ts`：与 p2p 流式卡的 ask 区块同构，两点不同——

1. 按钮 value 用 `kind: "group_ask"`（多带一个回群用的 `chatId`）；
   `card-action` 分发时**先于** owner 闸处理，群成员都能点
2. 独立静态卡（不是流式卡的一段），card-map 里**路由判据 `taskId` 记空串**
   （不参与 p2p 回复锚定），另记一组 `(askTaskId, askId)` 做 ask 索引（见下）

多题只渲染 markdown 不出按钮（同 p2p review P1#5：一点即整组提交会把未点题填
「（未回答）」误推进）；多题请 @bot 直接打字作答。

### 卡片终态置态：一个收口点、按 (taskId, askId) 反查

**欠账修复（2026-07-28）**：原来「答完把按钮换成一句话」只写在 card-action 的两个
按钮分支里 —— 也就是只有「**从这张卡点按钮**」才置态。从 app 答题卡答完 / 群里打字
作答 / 用户直接发新消息跳过时，群里那张橙色「待确认」卡原样挂着，看着还像待答。

收敛成 `ask-card-settle.settleAskCards(taskId, askId, …)`，了结这组 ask 的每条链各调一次：

| 了结入口 | 调用点 |
|---|---|
| app 答题卡答完 / 稍后再补充 | `ask-reply` 路由 `settleAnsweredCards()` |
| 群里打字作答 / 群答题卡点按钮 | `ask-inject.injectPendingAskText` 送达成功后（点按钮那条也走它，`card-action` 自己不再 patch） |
| p2p 卡点按钮 | `card-action.handleAskAction` |
| **用户不答、直接发新消息（跳过）** | `ask-skip.commit()` |

- 反查靠 card-map 的 ask 索引（`rememberAskCard` / `findAskCards`）：**p2p 流式卡和
  群答题卡可能同时承载同一组 ask，两张一起置**。流式卡建卡在前、追加提问在后，
  所以 `appendAskUser` 时补录索引（补录**不覆盖**路由判据 `taskId`）
- **幂等**：`claimAskCardSettle` 同步占坑、中间零 await，先到先得；一张都没置成才退坑
  （部分成功不退——退了会把已置态的卡再刷一遍）
- 「先到先得」的失效分支（`patchSingleButtonStale`）先看 `isAskCardSettled`：整卡已置终态时
  不再 patch 那颗按钮（element 早被删了、patch 只会白报一次飞书错误）
- **绝不抛**：置态是了结之后的增强动作，任何一步失败只 warn

## 行为策略（固定、不是设置项）

原本挂在设置页的三个开关 2026-07-28 全部砍掉（用户拍板「不需要那么多个性化挂设置」），
`settings.groupCollab` 字段一并从 schema 删除。取值固定在
`feishu-bridge/bridge-config.GROUP_COLLAB_POLICY`：

| 键 | 固定值 | 为什么 |
|----|--------|--------|
| `askToGroup` | `false` | agent 每次 `ask_user` 都往群里发卡太吵。用户自己在 app 里答；要别人帮忙时手动「分享到群」 |
| `advanceResultToGroup` | `true` | 别人在群里点了推进却看不到结果、这功能就废了 |
| `autoBroadcast` | `"off"` | 每个 action 跑完都刷群太吞 |

一句话原则：**默认不主动吵群，但别人主动在群里发起的操作一定有回应。**

三条链的代码**全部保留**（只是入参写死）——以后想重新放开或分场景差异化，
改 `GROUP_COLLAB_POLICY` 一处即可，下游读取点（`isAskToGroupEnabled` /
`isAdvanceResultToGroupEnabled` / `getGroupAutoBroadcastMode`）与注入契约一行不用动。
固定值由 `tests/feishu-group-collab-policy.test.ts` 钉住（含「盘上残留老 `groupCollab`
字段也不生效」），另在出向 / 播报两个测试里各接一次真实读取点。

⚠️ 老用户 config.json 里的 `groupCollab` 残留由 `normalizeSettings` 的退役键清理抹掉
（与 `username` / `gitHost` 同处），下次落盘即消失、读取侧一律不看它。

## 性能注意

`group-outbound` 挂的是**全局** task 流 tap，`assistant_delta` 是每 token 一发：
处理入口先做同步零 IO 预筛（非 ask 事件且该 task 没有「等着回群」的登记 → 立即返回），
**绝不能**在预筛前读 config.json。

## 复用点对照

| 能力 | 复用自 |
|------|--------|
| 消息内容解析（图 / 文件下载、markdown 形态兼容） | `router.parseInboundContent`（由 router 以 ctx 注入，避免成环） |
| 答 pendingAsk | `ask-inject.injectPendingAskText`（本期扩到 task 模式 + `answeredBy`、入口同步摘走 pending） |
| chat 模式消息注入（含排队） | `chat-inject.handleChatReplyInject` |
| task 模式消息注入 | `task-question-inject.handleTaskQuestionInject`（本期从 question route 抽出、route 变薄壳；非属主传 `restrictToQuestion`） |
| 推进 | `task-runner.advanceTask`（准入校验在它内部） |
| 推进选择卡数据源 | `advance-options.listAdvanceOptionGroupsForTask`（推进弹窗同款过滤链 / 分组序、server 复算） |
| 卡片按钮回调 | `card-action.handleCardActionEvent`（新增 `group_ask` / `group_advance` 分支） |
| 分享卡 | `feishu-group.shareToRequirementGroup`（推进产物回群 kind=artifact） |
| 事件流订阅 | `task-stream.subscribeAllTaskStreams`（同 p2p outbound 的 tap 模式） |

## 依赖方向约束（踩过必看）

`feishu-group` 静态引 `meegle-cli`，而大量 ownership 单测把 meegle-cli 整个 mock 成
只有 `resolveUserIdentityForPrompt` 一个导出。**挂在 router / bootstrap / task-runner
图上的模块一律不得静态 import `feishu-group`**——`group-route` / `group-outbound` /
`card-action` / `group-broadcast` 都走动态 `import()`，只在真要发群时求值。同理
`group-route` 从 `router` 只做 type-only import，两个运行时能力由 router 以 ctx 传入。

`group-broadcast` 是唯一被 **task-runner 静态引用**的群模块（播报要挂在后置检查
收口点里）——它的静态依赖必须全是 import 期无副作用的轻模块
（`bridge-config` / `group-shared` / `task-fs-core` / 纯 types），
对 `feishu-group` 只有 type-only import。

---

# 三期：自动播报

app 内跑完的 action 也自动进群——不用每次手点分享。实现入口
`src/lib/server/feishu-bridge/group-broadcast.ts`，触发点在
`task-runner.runActionPostCheck`。

## 触发点：action 完成的唯一收口

```
agent submit_work（非阻塞）
   ▼
runActionPostCheck（后台、独立 check 租约）
   ├─ runActionCheck（后置 deterministic check）
   ├─ patchActionAndRunStatusIfOpFresh → awaiting_ack / awaiting_user
   ├─ writeOwnedEventAndPublish「Action 产出完成、等待用户 ack」
   └─ broadcastActionToGroup ← 播报挂在这里（同一 patched 分支内）
```

选这里的理由：`awaiting_ack` 全仓**只有这一处**写（其余 `awaiting_ack` 出现点
是 stale 收尾或 ack 消费），且条件事务带结构条件
（`currentActionId` + `actionStatus: "running"`），天然「一次转换只落一次」。

**不另开写路径**：播报跑在收尾持有者的 `stillOwner()` 租约里——降级 info 事件
走 `writeOwnedEventAndPublish(taskId, stillOwner, …)`，租约丢了就不写（对齐
「授权检查必须在真实提交点紧前同步执行」）。播报本身不改任何 task 状态。

## 播报语义

| 档位 | 播什么 |
|------|--------|
| `off`（默认） | 不播。只有用户点分享 / agent 按 playbook 调 `share_to_group` 才发 |
| `ship` | 只有提测（`action.type === "ship"`）跑完播——群里最关心「提测了没、MR 在哪」 |
| `all` | 每个 action 跑完都播 |

走 `shareToRequirementGroup(kind: "artifact")`，即「瘦卡片 + md 文件」那一套：

- title = action 展示名（`actionDisplayLabel`，自定义 action 用它自己的 label）
- 正文 = artifact **全文、不截断**（进 md 文件；播报这条链早先截 1200 字，
  改内容形态后截了就是给群里发半份产物）
- 按钮 = 本 action 的 MR（`action.sideEffects.mrs`，一仓一个、最多 4 个）
  + `buildShareCardJson` 自动追加的「查看工作项」

⚠️ MR 取 **action 自己的** `sideEffects.mrs`、不是 `task.mrs`——后者是全历史，
用它会把上轮 ship 的旧 MR 一起挂上。

## 跳过 / 降级（全是「不影响主流程」）

判定顺序刻意「同步零 IO 在前」——每个 action 完成都会走一遍，不能上来就读盘。

| 顺序 | 条件 | 结果 | 原因 |
|------|------|------|------|
| 1 | 轻量任务（无 `feishuStoryUrl`） | `skipped_lightweight` | 没工作项 = 没需求群 |
| 2 | 档位不匹配（**固定 `off` → 常驻走这条**） | `skipped_mode` | 自动播报已关死；读档失败也按「不播」保守处理 |
| 3 | 该 task 有 `advance` 群回流登记 + `advanceResultToGroup` 开 | `skipped_group_reply` | 让位给 `group-outbound`，绝不发两张卡 |
| 4 | 桥接总开关关 | `skipped_bridge_off` | 与出向同口径 |
| 5 | 无 artifact / 读不到 / 空 | `skipped_no_content` | 不发空卡 |
| 6 | **工作项还没绑需求群 / 查群失败** | `skipped_no_group` | **播报绝不建群**，见下 |
| 7 | 已发过（防重表命中） | `skipped_duplicate` | 见下 |
| — | share 抛错（含 `bot_not_in_group`） | `failed` | warn 日志 + 事件流一条 info「群播报失败：xxx」 |
| — | 整体超 30s | `failed` | 不长期占着收尾方的 postcheck claim |

## 铁律：播报不建群

`shareToRequirementGroup` 内部是 `ensureRequirementGroup`——没群会**建群 + bind 工作项**。
那是「用户显式点分享」才该有的副作用；自动播报是后台行为，不能因为跑完一个 action
就替用户开一个群、还把 `group_type` 写进工作项（全组都看得见）。

所以播报路径先过 `getBoundGroupChatId`（**只读 `group_type`、不建群**）：没绑群直接
`skipped_no_group`，连 info 事件都不写（没群不是异常，只是这个需求还没人开始群协作）。
建群的口子只留给显式分享（API / MCP `share_to_group` / UI 分享按钮）。

代价：真有群时 `group_type` 会被读两次（gate 一次、ensure 里一次）。播报是低频动作，
换「绝不隐式建群」值。

`broadcastActionCompletion` **绝不抛**：内部全包 try/catch + 超时兜底，连降级
info 写失败都吞掉。调用方拿到返回值也不需要做任何事（返回值只给单测断言分支）。

## 防重（播报与 done flush 共用一张表）

`patchActionAndRunStatusIfOpFresh` 的结构条件保证「running→awaiting_ack 一次转换
只落一次」，但**重交卷会再来一轮**（用户「再聊聊」→ action 回 running → agent 改完
重新 submit_work）。所以另加一张防重表，放在 `group-shared.ts`：

- key = `taskId\0actionId`，挂 `globalThis`（防 dev route-chunk / HMR 分裂）
- **先占坑再发**（中间零 await）——并发两次调用第二次必然被挡
- 发失败**退坑**（一张卡都没发出去、下轮重新交卷该允许再试）；
  超时**不退坑**（在途请求可能仍会成功，退了会重发一张重复卡）
- 24h TTL、随调随清，不另起定时器

**两条链共用同一张表**（`claimGroupArtifactCard` / `releaseGroupArtifactCard`）：
`group-broadcast`（自动播报）与 `group-outbound.flushGroupAdvanceReply`（群内推进收口）
都要占坑才发。原因是「预筛让位」有窗口——flush 是 `takeGroupReplyByToken` **先取先删**，
两条链都由同一个 postcheck 收口点触发，谁先跑到占坑那一步不确定 → 同一份产物
两张卡（P2-1）。让位仍是第一道（省一次读盘），防重表是兜底那道。

## 与 agent 的关系（双指令源铁律）

播报是**系统行为**、不是 agent 行为。两处指令源必须同口径（现在都是「产物默认不进群」）：

- `prompts/action-ship.md` §6：产物默认不进群，agent 不要顺手调 `share_to_group`；
  只有用户明说才调。提测 @ 走 `notify_group_testers`，不是分享产物。
- `flowship-tools.ts` `share_to_group` describe：提测 @ 用 `notify_group_testers`，不要走本工具

提测群 @ 反过来是 **agent 行为**（和飞书项目评论同一拍）：playbook §4 写完评论立刻调 `notify_group_testers`，交卷收口不再补发。

## 功能全景

| 期 | 能力 | 状态 |
|----|------|------|
| **一** | 分享闭环（ensure + 卡片 + API + MCP） | ✅ |
| **二** | 群内回流（群消息 → 任务）+ 群内答题 + 群内推进 | ✅ |
| **三** | 自动播报：action 完成自动进群（`autoBroadcast` 三档） | ✅ 代码在、**档位固定 `off` 常驻不播** |
| **四** | UI 分享入口（整份产物 / 选中段） | ✅ |
| **五** | 成员自动注册表：建群一次带齐角色成员和他们的 bot | ✅ |

## UI 入口（产物面板）

| 入口 | 交互 | 发什么 |
|------|------|--------|
| toolbar「分享到群」 | 点 → 二次确认弹窗（一句话 + 取消 / 分享）→ 发 | `kind=artifact`：瘦卡片 + 全文 md 文件；MR 按钮由 `extractMrUrlsFromText` 从正文挖 |
| 选中正文一段 | 选中 → 就地浮出「分享到群」→ **点击直发、无确认** | `kind=message`：选中文本（截 4000）进卡片正文、**不发 md 文件**；发成功清选区 |

- 两条入口的失败引导都收在 `useShareToGroup`：bot 不在群 → `BotAddGuideDialog`；
  本人不在群 / 群没了 → `useDialog().confirm`「重新建群」（禁原生 confirm）。
  重建后的那一发**不再接引导**（`guided: false`），失败一律 toast 收口——不让引导链绕回自己
- 两个入口都只在**非轻量任务**（有飞书工作项）时出现；修订视图下关掉选区分享
  （那时正文是 diff 标记、选出来带增删痕迹）
- 确认弹窗**不放正文预览**：内容形态已是「卡片 + md 文件」、弹窗里塞一大块灰底摘要
  用户反馈「看着都不知道啥意思」，只留一句「把「<action 标题>」的完整产物发到需求群？」
- 选区浮动按钮与事件流「选中 AI 回复 → 引用」是**同一个公共件**
  （`components/ui/selection-float.tsx`：`useSelectionFloat` + `SelectionFloatButton`），
  定位 / 样式 / 防选区塌陷只有一份实现
- 出站正文口径收在 `lib/share-to-group.ts`（`prepareShareContent`：artifact 不截断、
  其余截 4000；`buildSelectionShareInput`：选中段载荷）——server / client 两侧都别再各写一份

## 单测

全部 mock 外部调用（**禁止真建群 / 真发消息 / 真起 agent**）。

- `tests/feishu-group.test.ts`：幂等查群、**建群按注册表拉人拉 bot**（全命中 / 部分未命中
  留痕 / 角色查询挂降级只拉发起人 / 没命中不塞空 `bot_id_list`）、进群协作即触发自动注册、
  并发双建收敛、群名回落、**发卡失败按错误码判 bot 不在群**（230002 一族命中带准确
  `botLabel`、无关错误照旧 lark_error）、**bot 名三级降级**（bot/v3/info → 应用名 → app_id）；
  **内容形态**：artifact 卡片不含正文 / 先卡片后文件（文件名 + 全文不截断）/
  **md 文件发失败只降级 warn、整体仍成功** / 选中段（message）只发卡不发文件 /
  文件名洗非法字符与兜底 / 出站正文口径（artifact 不截断、其余截 4000、选中段载荷）；
  **死绑定检测**（本人已退群 → `owner_not_in_group` 带群名且**一张卡都不发** / 还在群里
  照常发且回执带真实群名 / 查不出来 → `membershipUnknown` + 照常发 + 留痕 /
  不开 `verifyOwnerMembership` 时探针一次都不调 / 群解散 → `group_unreachable` /
  读群名失败是缺 scope 或网络抖时**不判死**）；
  **重建**（`recreateFrom` 跳过复用 + bind 覆盖 + 二次读到老绑定不收敛回去 + 不再问一遍 /
  绑定已被换群时不重建走正常校验 / 真有别人抢先 bind 仍收敛）。
  ⚠️ 新增「分享 artifact」的用例必须桩掉 `sendDoc`——默认实现会真落临时盘 + 起 lark-cli
- `tests/feishu-bridge-lark-api.test.ts`：**瞬时失败重试**（幂等 GET 重试后成功 /
  传输错误只落 stderr 也认得出 / **写操作撞 EOF 一次都不重试** / 写操作挂在取 token
  那一跳照样重试 / 业务错误不重试 / 封顶 3 次尝试）、**群探针**（`fetchChatInfo` 取群名走
  bot、`probeSelfInChat` **必须走 user 身份**、响应缺判定字段就抛而不是瞎猜）
- `tests/share-to-group-client.test.ts`：客户端响应归一——成功回执带群名、
  `owner_not_in_group` / `group_unreachable` → `needGroupRebuild` + 失效 chatId、
  `bot_not_in_group` 不误触发重建、`recreateFrom` 原样进请求体
- `tests/feishu-group-registry.test.ts`：注册表解析容错（坏 JSON / 缺 openId / 非邮箱 key /
  大小写重复条目）、序列化稳定序、**按 email 逐条 merge（新者胜、相等保留 base）**、
  建群载荷挑选（去重 / 排除本机 bot / 50 与 5 的上限 / 未命中跳过）、
  **注册幂等**（本地快查 + fetch 后二次判定、都不产生空提交）、
  **并发合并**（mutate 拿到分支最新、同事条目原样保留）、数据分支还没建时照常创建、
  **静默失败**（拒推 / 写入口抛异常 → 只 warn 不抛）、
  身份不齐 skipped、`scheduleSelfRegistration` 成功后不重跑 + 失败退避；
  外加两个数据源的解析（`parseWorkitemRoleMembers` / `parseUserSearchEmail`）
- `tests/team-library.test.ts`（真跑 git、本地 bare 远端）：**数据分支读改写**——
  分支不存在时建**孤儿分支**首推、`main` 不受影响、**主克隆 HEAD / 工作树全程纹丝不动**、
  推完立刻能读到（跟踪 ref 已对齐）、幂等不造提交、**并发写被拒后重新 fetch 拿到对手
  最新内容再合并**、分支 / 文件缺失读 null、非法文件名与分支名拒绝
- `tests/feishu-group-inbound.test.ts`：@ 过滤三层、chat_id→task 反查与正负缓存、
  来源前缀与 meta（含 `sender_name` 缺失退泛称）、非属主推进拒绝、action 别名与
  自定义 label / skill 模糊匹配、**无参「推进」回选择卡**（value 结构 / 空清单引导 /
  超 20 截断）、**选择卡回调**（属主闸 / 同卡二次点击「已在跑」/ 失败退坑重选）、
  群内答题带答题人、`no_pending` 降级、群答题卡结构；**并发登记**（A 跑起来后 B 被拒 /
  B 失败按 token 回滚 A）、**非属主只答疑**（`restrictToQuestion` + 起得起受限 agent 的凭据 +
  降信任前缀 + 答题不受限 + 注入链 4xx 时回群报错并摘登记）、
  **登记通道与 token 下传**（非属主挂旁路通道且 token 传给注入链 / 属主通道 runTag=null /
  `no_pending` 竞态改挂旁路）、**旁路在飞拒推进**（打字与选择卡两条路）、
  **新一轮推进顶掉上一轮**（回执 @ 上一轮发起人且排在本轮受理之前 / 「推进结果回群」
  关掉时不发 / 本轮没启动起来则老登记原样放回且不发假回执）
- `tests/advance-options.test.ts`：server 复算的可推进清单与推进弹窗同口径
  （布局顺序显隐 / 分组序 / 日常任务只列自定义 / 关 skill / 团队规范开关 / legacy 滤除）
- `tests/feishu-group-outbound.test.ts`：ask 卡发群（两个开关 + 未绑群）、回答攒 delta
  后 @ 提问人回群（**post markdown**、不是纯文本）、done 后登记摘除、推进产物走 share 卡、share 失败降级发文本、
  **产物卡先占再发**（播报已占坑就不发第二张 / 发失败退坑）；
  **token 化投递**（属主 done 先到不动旁路登记 / 两条登记并存各投各的 / stop 补发的
  无 origin done 不误 flush / 多位同事各自 token / assistant_message 兜底也认 origin）、
  **推进收口看 action 状态**（ask_user 中途的 done 既不收登记也不占防重坑、随后的
  `task` / `action` 帧才发真产物、cancelled / error 回失败文案、`done(ok=false)` 立刻收口、
  终态无产物按文本回旁白、actionId 未补记时继续等、question 登记不被 `task` 帧误收）、
  **到期收口**（仍在跑续租 / 已终态补发 / 查不到 action 摘登记 + 回执 / 结果回群关掉不回执 /
  **桥接总开关关掉也不发回执且登记留着** / 读盘失败什么都不做）、
  **登记表本身**（属主单格但 advance 不被 question 顶掉 + 旁路并存、跨通道回滚互不干扰、
  容量上限、TTL 过期、`hasGroupAdvanceReplyFor` 只认精确 actionId、
  **回滚放回过期 advance 但不放回过期 question**）
- `tests/feishu-group-broadcast.test.ts`：三档判定、轻量任务 / 桥接关 / 无产物跳过、
  **没绑群不建群**、让位群内推进、防重（含失败退坑、含 flush 已占坑）、
  失败降级成 info 且不抛、MR 按钮只取本 action
- `tests/feishu-group-tester-notify.test.ts`：提测需求群 @ 测试（注册表换 open_id /
  没群 / 没人 / 冲突 / bot 不在群静默 / 同一 action 只发一次）；agent 工具 `notify_group_testers` 调这条，交卷不再补发
- `tests/task-question-inject-restrict.test.ts`：`restrictToQuestion` 五条硬拦各带对照组
  （不复用活会话 / 不带 ackContext 不 snapshot 不打回 running / 会话断不 resume /
  起的是 `startRestrictedGroupQuestion` 不是属主那条 one-shot / **一个字节 runStatus 都不写**）
- `tests/restricted-group-question.test.ts`（**从 `handleTaskQuestionInject` 真链路跑起**、
  只假 SDK，**刻意不 mock chat-pending**——上一轮把它打桩成恒等函数，prompt 负向断言恒绿）：
  全程不写 runStatus / 不占 runningTasks / 不动属主会话与 action、受限 prompt 无一句放行
  措辞且「# 边界」是最后一段、`Agent.create` 不带 MCP、create / send 挂掉都只经同一条收口
  发一次 `done(ok=false)` + error 事件、`cancelRestrictedQuestions` 能叫停在飞的旁路、
  **事件身份**（delta / assistant_message / done 都带 `origin` = 群侧登记 token、
  没给 token 也自生成）、**在飞信号**（起跑 active=true、收口 false，全程不写 runStatus）
- `tests/restricted-run-signal.test.ts`：登记表变化即发 `restricted_run`（两条并发时
  先退出的那条不许打成 false）、客户端 `watchTaskStream` 分发到 `onRestrictedRun`
  （缺 active 的坏帧不回调）、接线契约（详情页把信号并进 `isRunning`、
  watch-task 既转发又在 bootstrap 补当前值）
- `tests/oneshot-question-bailout.test.ts`（属主那条 `startOneShotQuestion`、跑真代码）：
  prompt 是「疑问就答、要改就改」、活会话在场让位但收口三件套（恢复 runStatus + error 事件
  + `done(ok=false)`）、真 run 在飞时让位且不动 runStatus
- `tests/ask-inject-single-delivery.test.ts`：跨链并发只投一份答案、失败按条件放回
- `tests/ask-card-settle.test.ts`：card-map 的 ask 索引（两张卡都反查得到 / 补录不覆盖路由判据 /
  跨 task 跨 ask 不串）、**从别处了结时两张卡一起置终态**（欠账主用例）、逐题文案优先、
  幂等只置一次、全失败退坑可重试、没记上卡不占坑、单张失败不影响另一张
- `tests/ask-skip.test.ts` / `tests/ask-skip-chat.test.ts`：「不答提问直接发新消息 = 跳过」——
  认领 / 提交 / 回滚协议、agent 消息带跳过上下文、**并发答 / 跳只有一个赢**、孤儿 ask 仍可跳过、
  群里非属主不许跳过属主的提问、chat 三条送达路径（send / 排队 / 起新会话）各钉一遍
- `tests/feishu-bridge-card-action.test.ts`：`group_ask` 非 owner 放行、先到先得失效分支、
  **来源 chat 取值链五种 schema**（扁平 / 嵌套 / `event.context.open_chat_id`）、
  `group_advance` value 解析与分发 + **来源 chat 校验**（转发出去点了丢弃、缺来源退 owner 闸）、
  **点按钮答完也登记回群**（与群里打字作答同一个结果；送达失败回滚登记；
  推进登记在飞时不另开登记）
