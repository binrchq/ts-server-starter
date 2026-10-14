/**
 * ESLint 9 扁平原生配置。
 *
 * 几个刻意的选择：
 *  1. 类型感知规则（recommended-type-checked）—— 「未 await 的 Promise」
 *     「把 any 传进泛型」这类问题只有拿到类型信息才看得出来，
 *     而它们恰恰是后端最常见的线上事故源
 *  2. 格式交给 prettier，lint 只管正确性，避免两套工具互相打架
 *  3. 类型规则只作用于 .ts：直接在 .mjs 上跑 typed 规则会直接报错，
 *     因为那个文件不属于任何 tsconfig
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'logs/**', 'ROUTERS.md'] },

  // ── TypeScript 源码与测试：开类型感知
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // 显式列出两个 tsconfig：源码在 tsconfig.json，
        // 测试在 tsconfig.test.json（rootDir 不同，无法合并）
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'off',
      // 本项目的依赖几乎都是「接口 + 对象字面量实现」，
      // 把接口方法当值传递（DI 注册、回调表）是刻意设计而非笔误。
      // 该规则只对 class 实例方法有价值，因此这里关闭并用测试覆盖引用正确性。
      '@typescript-eslint/unbound-method': 'off',
      // 日志/审计里出现 any 往往是脱敏漏掉的前兆，所以保持可见
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // ── 测试文件：放宽几条只对生产代码有意义的要求
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // ── 构建脚本：纯 JS，不适用类型规则
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
