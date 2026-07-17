import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      'extension/dist/**',
      'node_modules/**',
      '**/*.svelte',
      // VitePress build output and dep-optimizer cache: generated, gitignored,
      // and full of minified vendor bundles that eslint must not lint.
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      // The cloud/* submodules are separate repos with their own toolchains
      // (their own typecheck + tests); the umbrella lint must not reach into
      // their source. CI does not check them out, so this only affects a local
      // `pnpm run lint` when the submodules are present.
      'cloud/adapter/**',
      'cloud/runner/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { project: false },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
    },
  },
  {
    // Test files - allow expressive any and unused placeholder args.
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Extension code runs in the Chrome MV3 sandbox (browser + chrome.* APIs).
    // TypeScript already checks identifiers; disable no-undef so DOM type
    // references (ParentNode, HeadersInit, …) don't trip eslint.
    files: ['extension/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
    rules: { 'no-undef': 'off' },
  },
];
