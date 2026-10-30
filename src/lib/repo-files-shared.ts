/**
 * `@` 文件搜索前后端共用常量（无 node 依赖，client 可安全 import）
 */

/** 模糊匹配返回上限 */
export const REPO_FILES_RESULT_LIMIT = 50;

/** 查询串长度上限 */
export const REPO_FILES_Q_MAX_LEN = 200;

/**
 * 单个仓最多收录的条目数（文件 + 目录）：服务端建索引的上限，防超大仓把内存打爆；
 * 也是菜单里「仅索引前 N 项」提示的数字来源——前后端共用这一个常量，不会改了一边忘了另一边。
 */
export const REPO_FILES_MAX_ENTRIES = 20_000;
