"use strict";

const serverlessWebpack = require("serverless-webpack");

const { name, version } = require("./package");

module.exports = {
  entry: serverlessWebpack.lib.entries,
  mode: "development",
  module: {
    rules: [
      {
        test: /serverless-lambda\/views\/probot\.js$/u,
        use: {
          loader: "string-replace-loader",
          options: {
            replace: JSON.stringify({ name, version }),
            // eslint-disable-next-line no-template-curly-in-string
            search: "require(`${process.cwd()}/package`)",
          },
        },
      },
      {
        test: /serverless-lambda\/index\.js$/u,
        use: {
          loader: "string-replace-loader",
          options: {
            replace: "name: e,",
            search: "event: e,",
          },
        },
      },
      {
        exclude: /node_modules/u,
        test: /\.js$/u,
        use: {
          loader: "babel-loader",
          options: {
            cacheDirectory: true,
          },
        },
      },
      {
        test: /\.mjs$/u,
        type: "javascript/auto",
      },
    ],
  },
};
