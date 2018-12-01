import * as toLambda from "probot-serverless-now";

import * as applicationFunction from "./app";

export = toLambda(applicationFunction);
