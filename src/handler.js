// @flow

import { serverless } from "@probot/serverless-lambda";

import autorebase from "./autorebase";

const probot = serverless(app => {
  app.on("*", async context => {
    const { owner, repo } = context.repo();
    const action = await autorebase({
      // $FlowFixMe unable to recognize as valid Event.
      event: { name: context.name, payload: context.payload },
      octokit: context.github,
      options: { label: "autorebase" },
      owner,
      repo,
    });
    context.log(action);
  });
});

export { probot };
