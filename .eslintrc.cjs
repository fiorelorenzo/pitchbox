module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: false, ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['**/dist/**', '**/build/**', '**/.svelte-kit/**', 'extension/dist/**'],
};
