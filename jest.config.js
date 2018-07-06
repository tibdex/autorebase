"use strict";

module.exports = {
  coveragePathIgnorePatterns: ["/lib/", "/node_modules/"],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
};
