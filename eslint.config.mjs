import cds from '@sap/cds/eslint.config.mjs';
import tseslint from 'typescript-eslint';

export default [
  ...cds.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['srv/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // CJS interop requires `import x = require()` / module.exports in a few
      // places (export-equals modules). Disallow plain `require()` calls in
      // function bodies but tolerate the TS-syntax import = require().
      '@typescript-eslint/no-require-imports': ['error', { allow: [] }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
