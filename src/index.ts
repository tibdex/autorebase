import { Application } from "probot";

import autorebase from "./autorebase";

module.exports = (app: Application) => {
  app.log("App loaded");

  app.on("*", async context => {
    const { owner, repo } = context.repo();
    const action = await autorebase({
      // @ts-ignore The event is of the good type because Autorebase only subscribes to a subset of webhooks.
      event: { name: context.name, payload: context.payload },
      // @ts-ignore The value is the good one even if the type doesn't match.
      octokit: context.github,
      options: { label: "autorebase" },
      owner,
      repo,
    });
    context.log(action);
  });
};
