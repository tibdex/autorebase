import { toLambda } from "probot-serverless-now";

import {
  createApplicationFunction,
  requireWriteAccessForOneTimeRebase,
} from "./app";

const nopHandler = () => Promise.resolve();

export = toLambda(
  createApplicationFunction({
    canRebaseOneTime: requireWriteAccessForOneTimeRebase,
    handleAction: nopHandler,
    handleEvent: nopHandler,
    label: "autorebase",
  }),
);
