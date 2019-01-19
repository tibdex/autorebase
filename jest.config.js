"use strict";

module.exports = {
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
  preset: "ts-jest",
  reporters: ["default", ["jest-junit", { output: "./reports/junit.xml" }]],
  testEnvironment: "node",
  testRunner: "jest-circus/runner",
};
