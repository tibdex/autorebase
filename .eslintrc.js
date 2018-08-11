"use strict";

module.exports = {
  env: {
    commonjs: true,
    es6: true,
    "shared-node-browser": true,
  },
  extends: [
    "eslint:all",
    "plugin:flowtype/recommended",
    "plugin:import/recommended",
    "plugin:security/recommended",
    "plugin:unicorn/recommended",
    "prettier",
    "prettier/flowtype",
  ],
  parser: "babel-eslint",
  parserOptions: {
    ecmaVersion: 2017,
    sourceType: "script",
  },
  plugins: ["flowtype", "import", "security", "unicorn"],
  root: true,
  rules: {
    // Octokit follows GitHub API naming convention and thus uses camelcase a lot.
    camelcase: "off",
    "capitalized-comments": "off",
    // Flow takes care of the rest, same thing for no-eq-null.
    eqeqeq: ["error", "smart"],
    "multiline-comment-style": ["error", "separate-lines"],
    "no-eq-null": "off",
    "no-magic-numbers": "off",
    "no-ternary": "off",
    "one-var": "off",
    // Not supported by babel-preset-env yet.
    "prefer-object-spread": "off",
    // The import plugin already takes care of this.
    "sort-imports": "off",
    "sort-keys": ["error", "asc", { caseSensitive: false, natural: true }],
  },
};
