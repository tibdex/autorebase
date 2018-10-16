// @flow strict

import type { Github } from "@octokit/rest";
import rebasePullRequest, { needAutosquashing } from "github-rebase";
import {
  type PullRequestNumber,
  type RepoName,
  type RepoOwner,
  type Sha,
  deleteReference,
} from "shared-github-internals/lib/git";

import {
  type LabelName,
  type PullRequestPayload,
  debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  withLabelLock,
} from "./utils";

type Options = {
  // Pull requests without this label will be ignored.
  label: LabelName,
};

type Action =
  // When Autorebase tries to rebase a pull request that doesn't have the label anymore.
  | {| number: PullRequestNumber, type: "abort" |}
  | {| number: PullRequestNumber, type: "merge" |}
  | {| number: PullRequestNumber, type: "rebase" |}
  | {| type: "nop" |};

/**
 * See https://developer.github.com/webhooks/#events
 */
type Event =
  | {|
      name: "pull_request",
      payload: {
        action: "closed" | "opened" | "synchronize",
        pull_request: PullRequestPayload,
      },
    |}
  | {|
      name: "pull_request",
      payload: {
        action: "labeled",
        label: { name: LabelName },
        pull_request: PullRequestPayload,
      },
    |}
  | {|
      name: "pull_request_review",
      payload: {
        action: "dismissed" | "edited" | "submitted",
        pull_request: PullRequestPayload,
      },
    |}
  | {|
      name: "status",
      payload: {
        sha: Sha,
      },
    |};

const merge = async ({ head, number, octokit, owner, repo }) => {
  debug("merging", number);
  await octokit.pullRequests.merge({
    merge_method: "rebase",
    number,
    owner,
    repo,
  });
  debug("merged", number);
  debug("deleting reference", head);
  await deleteReference({ octokit, owner, ref: head, repo });
  debug("reference deleted", head);
  return {
    number,
    type: "merge",
  };
};

const rebase = async ({ label, number, octokit, owner, repo }) => {
  debug("rebasing", number);
  const rebased = await withLabelLock({
    async action() {
      await rebasePullRequest({
        number,
        octokit,
        owner,
        repo,
      });
    },
    label,
    number,
    octokit,
    owner,
    repo,
  });

  if (!rebased) {
    debug("other process already rebasing, aborting", number);
    return { number, type: "abort" };
  }

  debug("rebased", number);
  return { number, type: "rebase" };
};

const findAndRebasePullRequestOnSameBase = async ({
  base,
  label,
  octokit,
  owner,
  repo,
}) => {
  debug("searching for pull request to rebase on same base", base);
  const pullRequest = await findOldestPullRequest({
    extraSearchQualifiers: `base:${base}`,
    label,
    octokit,
    owner,
    predicate: ({ mergeableState }) => mergeableState === "behind",
    repo,
  });
  debug("pull request to rebase on same base", pullRequest);
  return pullRequest
    ? rebase({
        label,
        number: pullRequest.number,
        octokit,
        owner,
        repo,
      })
    : { type: "nop" };
};

const autorebasePullRequest = async ({
  label,
  octokit,
  owner,
  pullRequest,
  repo,
}) => {
  debug("autorebasing pull request", { pullRequest });
  const shouldBeAutosquashed = await needAutosquashing({
    number: pullRequest.number,
    octokit,
    owner,
    repo,
  });
  debug("should be autosquashed", {
    number: pullRequest.number,
    shouldBeAutosquashed,
  });
  const shouldBeRebased =
    shouldBeAutosquashed || pullRequest.mergeableState === "behind";
  if (shouldBeRebased) {
    return rebase({ label, number: pullRequest.number, octokit, owner, repo });
  }
  if (pullRequest.mergeableState === "clean") {
    return merge({
      head: pullRequest.head,
      number: pullRequest.number,
      octokit,
      owner,
      repo,
    });
  }
  return { type: "nop" };
};

/* eslint-disable max-statements,max-lines-per-function */

const autorebase = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  event,
  octokit,
  options,
  owner,
  repo,
}: {
  _intercept?: () => Promise<void>,
  event: Event,
  octokit: Github,
  options: Options,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Action> => {
  const { label } = options;
  debug("starting", { label, name: event.name });

  if (event.name === "status") {
    const pullRequest = await findAutorebaseablePullRequestMatchingSha({
      label,
      octokit,
      owner,
      repo,
      sha: event.payload.sha,
    });

    if (pullRequest) {
      debug("autorebaseable pull request matching status", pullRequest);
      if (pullRequest.mergeableState === "clean") {
        return merge({
          head: pullRequest.head,
          number: pullRequest.number,
          octokit,
          owner,
          repo,
        });
      } else if (pullRequest.mergeableState === "blocked") {
        // Happens when an autorebaseable pull request gets blocked by an error status.
        // Assuming that the autorebase label was added on a pull request behind but with green statuses,
        // it means that the act of rebasing the pull request made it unmergeable.
        // Some manual intervention will have to be done on the pull request to unblock it.
        // In the meantime, in order not to be stuck,
        // Autorebase will try to rebase another pull request based on the same branch.
        return findAndRebasePullRequestOnSameBase({
          base: pullRequest.base,
          label,
          octokit,
          owner,
          repo,
        });
      }
    }
  } else {
    const pullRequest = await getPullRequestInfoWithKnownMergeableState({
      label,
      octokit,
      owner,
      pullRequest: event.payload.pull_request,
      repo,
    });
    debug("pull request from payload", pullRequest);

    if (event.name === "pull_request") {
      if (
        pullRequest.labeledAndOpenedAndRebaseable &&
        (event.payload.action === "opened" ||
          event.payload.action === "synchronize" ||
          (event.payload.action === "labeled" &&
            event.payload.label.name === options.label))
      ) {
        await _intercept();
        return autorebasePullRequest({
          label,
          octokit,
          owner,
          pullRequest,
          repo,
        });
      } else if (event.payload.action === "closed" && pullRequest.merged) {
        return findAndRebasePullRequestOnSameBase({
          base: pullRequest.base,
          label,
          octokit,
          owner,
          repo,
        });
      }
    } else if (
      pullRequest.labeledAndOpenedAndRebaseable &&
      event.name === "pull_request_review" &&
      event.payload.action === "submitted" &&
      pullRequest.mergeableState === "clean"
    ) {
      return merge({
        head: pullRequest.head,
        number: pullRequest.number,
        octokit,
        owner,
        repo,
      });
    }
  }

  return { type: "nop" };
};

export type { Options };

export default autorebase;
