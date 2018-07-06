/* eslint-env node */
/* eslint-disable security/detect-non-literal-regexp */

"use strict";

const path = require("path");

const pkgDir = require("pkg-dir");
const webpack = require("webpack");

const { dependencies } = require("./package");

module.exports = {
  entry: require.resolve("./src"),
  externals: new RegExp(`^(${Object.keys(dependencies).join("|")})(/.*)?$`),
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
    // Keep the lib code readable.
    minimize: false,
  },
  output: {
    filename: "index.js",
    libraryTarget: "commonjs2",
    path: path.join(pkgDir.sync(__dirname), "lib"),
  },
  plugins: [new webpack.IgnorePlugin(/^encoding$/, /node-fetch/)],
  target: "node",
};
