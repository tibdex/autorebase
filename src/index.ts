import * as toLambda from "probot-serverless-now";

import { createApplicationFunction } from "./app";

const nopHandler = () => Promise.resolve();

export = toLambda(
  createApplicationFunction({
    handleAction: nopHandler,
    handleEvent: nopHandler,
    label: "autorebase",
  }),
);
