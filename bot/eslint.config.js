// ESLint, flat config. Deliberately minimal: the recommended rule set and nothing else.
//
// The point of this is bugs - unused variables, unreachable code, shadowed bindings, promise
// mistakes, redeclarations - not style. No stylistic rules, no formatter, no opinionated plugin
// packs: those would argue with code that already reads consistently and would bury anything real
// under churn. If a rule here ever fires on something we do on purpose, turn that one rule off
// with a comment saying why, rather than reaching for a bigger config.
//
// Run it with: npm run lint

import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // node_modules is ignored by default; this keeps the linter off anything else that is not ours.
    ignores: ['node_modules/**', 'coverage/**']
  },
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      // The bot is ESM ("type": "module" in package.json) and runs on Node >= 20, so `process`,
      // `console`, `setTimeout` and friends are defined even though nothing imports them.
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...js.configs.recommended.rules
    }
  }
]
