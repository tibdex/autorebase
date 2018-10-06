/* eslint-env node */

"use strict";

const presetEnv = require("@babel/preset-env");
const presetFlow = require("@babel/preset-flow");

// eslint-disable-next-line no-process-env
const env = process.env.NODE_ENV;

module.exports = {
  presets: [
    [
      presetEnv,
      {
        targets: {
          node: env === "test" ? true : "6.11.2",
        },
      },
    ],
    presetFlow,
  ],
};
