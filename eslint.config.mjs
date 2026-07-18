import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next 15 还是 legacy（eslintrc）格式、用 FlatCompat 桥接
// next/core-web-vitals：Next 默认严格规则集
// next/typescript：补 TS 相关 rule（含 react-hooks/exhaustive-deps 等）
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "data/**",
      "next-env.d.ts", // Next 生成文件（triple-slash reference 是它的固定形态）
      "src/components/ui/**", // shadcn 生成的、不让规则去管
      "scripts/**",
    ],
  },
  {
    // Electron preload 必须是 CJS（sandbox 下主进程按 CJS 加载）——require 是唯一写法
    files: ["electron-app/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // R27-6 静态门禁：runner / SDK 翻译器内禁「不带第三参 lease」的 writeEventAndPublish
    // （缺省 fail-open）。owner 语境改用 writeOwnedEventAndPublish(taskId, lease, ev)；
    // 确属用户直接操作 / 终态 owner / stop 链的无条件语义，逐处 eslint-disable-next-line
    // 豁免并注明中文理由。按 CallExpression 参数个数匹配（<3 = 无 lease）。
    files: [
      "src/lib/server/task-runner.ts",
      "src/lib/server/chat-runner.ts",
      "src/lib/server/sdk-message-handler.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='writeEventAndPublish'][arguments.length<3]",
          message:
            "R27-6：writeEventAndPublish 须带第三参 lease；owner 语境改用 writeOwnedEventAndPublish；用户操作/终态 owner/stop 链请 eslint-disable-next-line 并注明理由",
        },
      ],
    },
  },
];

export default config;
