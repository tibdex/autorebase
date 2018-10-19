/* eslint-env node */

"use strict";

const presetEnv = require("@babel/preset-env");
const presetFlow = require("@babel/preset-flow");

module.exports = {
  presets: [
    [
      presetEnv,
      {
        targets: {
          node: true,
        },
      },
    ],
    presetFlow,
  ],
};
