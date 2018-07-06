/* eslint-env node */

"use strict";

const path = require("path");

const CopyWebpackPlugin = require("copy-webpack-plugin");
const pkgDir = require("pkg-dir");
const webpack = require("webpack");
const ZipPlugin = require("zip-webpack-plugin");

const { name } = require("./package");

module.exports = {
  entry: require.resolve("./src/main"),
  mode: "production",
  module: {
    rules: [
      {
        exclude: /node_modules/,
        test: /\.js$/,
        use: {
          loader: require.resolve("babel-loader"),
        },
      },
    ],
  },
  optimization: {
    // Keep the app code readable.
    minimize: false,
  },
  output: {
    filename: "GitHubWebhook/index.js",
    libraryTarget: "commonjs2",
    path: path.join(pkgDir.sync(__dirname), "lib"),
  },
  plugins: [
    new webpack.IgnorePlugin(/^encoding$/, /node-fetch/),
    new CopyWebpackPlugin(["src/wwwroot"]),
    new ZipPlugin({ filename: path.format({ base: name, ext: ".zip" }) }),
  ],
  target: "node",
};
