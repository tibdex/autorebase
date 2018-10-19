import autorebase from "./autorebase";

module.exports = app => {
  app.log("App loaded");

  app.on("*", async context => {
    const { owner, repo } = context.repo();
    const action = await autorebase({
      event: { name: context.name, payload: context.payload },
      octokit: context.github,
      options: { label: "autorebase" },
      owner,
      repo,
    });
    context.log(action);
  });
};
