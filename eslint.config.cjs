'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'work/**', 'App/**', 'dist/**', 'src/renderer/vendor/**'] },
  { ...js.configs.recommended, files: ['**/*.{js,cjs}'], languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
