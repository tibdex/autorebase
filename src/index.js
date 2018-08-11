import autorebase from "./autorebase";

module.exports = app => {
  app.log("App loaded");

  app.on(
    ["pull_request.labeled", "push", "status", "pull_request_review.submitted"],
    async context => {
      const { owner, repo } = context.repo();
      const action = await autorebase({ octokit: context.github, owner, repo });
      context.log(action);
    }
  );
};
