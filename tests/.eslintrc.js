module.exports = {
  env: { jest: true, node: true },
  extends: require.resolve("../.eslintrc"),
  parserOptions: {
    sourceType: "module",
  },
  rules: {
    "init-declarations": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-statements": "off",
  },
};
