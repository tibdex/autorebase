module.exports = {
  env: { node: true },
  extends: require.resolve("../../../.eslintrc"),
  parserOptions: {
    sourceType: "module",
  },
  rules: {
    "security/detect-object-injection": "off",
  },
};
