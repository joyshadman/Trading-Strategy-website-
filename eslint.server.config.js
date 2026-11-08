// Shared ESLint setup for the TypeScript workspaces (apps/server, packages/shared).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Money and sizes are decimal strings or Decimal, never JS numbers. These bans back AC-5.
const noFloatMoney = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: 'Use toDecimal() from @trading/shared for money and sizes.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.name='Number']",
      message: 'Use toDecimal() for money and sizes, or z.coerce.number() for settings.',
    },
    {
      selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
      message: 'Use toDecimal() from @trading/shared for money and sizes.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist', 'src/generated'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      ...noFloatMoney,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
