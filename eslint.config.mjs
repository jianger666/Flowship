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
];

export default config;
