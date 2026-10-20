'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'work/**', 'App/**', 'dist/**', 'src/renderer/vendor/**'] },
  { ...js.configs.recommended, files: ['**/*.{js,cjs}'], languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser } },
    // Keep the recommended rules: a plain `rules` key here would replace them.
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Stripping control characters from names, paths and terminal output is deliberate.
      'no-control-regex': 'off',
    },
  },
];
