"use strict";

module.exports = {
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 100,
      lines: 90,
      statements: 90,
    },
  },
  preset: "ts-jest",
  reporters: ["default", ["jest-junit", { output: "./reports/junit.xml" }]],
  testEnvironment: "node",
};
