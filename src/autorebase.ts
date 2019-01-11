import * as Octokit from "@octokit/rest";
import rebasePullRequest, { needAutosquashing } from "github-rebase";
import {
  deleteReference,
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
} from "shared-github-internals/lib/git";

import {
  debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  LabelName,
  PullRequestInfo,
  PullRequestPayload,
  withLabelLock,
} from "./utils";

/**
 * When Autorebase tries to rebase a pull request that doesn't have the label anymore.
 */
type AbortAction = { pullRequestNumber: PullRequestNumber; type: "abort" };

type MergeAction = { pullRequestNumber: PullRequestNumber; type: "merge" };

type RebaseAction = { pullRequestNumber: PullRequestNumber; type: "rebase" };

type FailedAction = { error: Error; type: "failed" };

type NopAction = { type: "nop" };

type Action =
  | AbortAction
  | FailedAction
  | MergeAction
  | RebaseAction
  | NopAction;

/**
 * See https://developer.github.com/webhooks/#events
 */
type Event =
  | {
      name: "check_run";
      payload: {
        check_run: {
          head_sha: Sha;
        };
      };
    }
  | {
      name: "pull_request";
      payload:
        | {
            action: "closed" | "opened" | "synchronize";
            pull_request: PullRequestPayload;
          }
        | {
            action: "labeled";
            label: { name: LabelName };
            pull_request: PullRequestPayload;
          };
    }
  | {
      name: "pull_request_review";
      payload: {
        pull_request: PullRequestPayload;
      };
    }
  | {
      name: "status";
      payload: {
        sha: Sha;
      };
    };

const merge = async ({
  head,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  head: Reference;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<MergeAction> => {
  debug("merging", pullRequestNumber);
  await octokit.pullRequests.merge({
    merge_method: "rebase",
    number: pullRequestNumber,
    owner,
    repo,
  });
  debug("merged", pullRequestNumber);
  debug("deleting reference", head);
  await deleteReference({ octokit, owner, ref: head, repo });
  debug("reference deleted", head);
  return {
    pullRequestNumber,
    type: "merge",
  };
};

const rebase = async ({
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  label: LabelName;
  pullRequestNumber: PullRequestNumber;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<AbortAction | RebaseAction> => {
  debug("rebasing", pullRequestNumber);

  try {
    const rebased = await withLabelLock({
      async action() {
        await rebasePullRequest({
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
      },
      label,
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });

    if (!rebased) {
      debug("other process already rebasing, aborting", pullRequestNumber);
      return { pullRequestNumber, type: "abort" };
    }

    debug("rebased", pullRequestNumber);
    return { pullRequestNumber, type: "rebase" };
  } catch (error) {
    const message = "rebase failed";
    debug(message, error);
    await octokit.issues.createComment({
      body: [`The rebase failed:`, "", "```", error.message, "```"].join("\n"),
      number: pullRequestNumber,
      owner,
      repo,
    });
    throw new Error(message);
  }
};

const findAndRebasePullRequestOnSameBase = async ({
  base,
  label,
  octokit,
  owner,
  repo,
}: {
  base: Reference;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<AbortAction | RebaseAction | NopAction> => {
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
        octokit,
        owner,
        pullRequestNumber: pullRequest.pullRequestNumber,
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
}: {
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequest: PullRequestInfo;
  repo: RepoName;
}): Promise<Action> => {
  debug("autorebasing pull request", { pullRequest });
  const shouldBeAutosquashed = await needAutosquashing({
    octokit,
    owner,
    pullRequestNumber: pullRequest.pullRequestNumber,
    repo,
  });
  debug("should be autosquashed", {
    pullRequestNumber: pullRequest.pullRequestNumber,
    shouldBeAutosquashed,
  });
  const shouldBeRebased =
    shouldBeAutosquashed || pullRequest.mergeableState === "behind";
  if (shouldBeRebased) {
    return rebase({
      label,
      octokit,
      owner,
      pullRequestNumber: pullRequest.pullRequestNumber,
      repo,
    });
  }
  if (pullRequest.mergeableState === "clean") {
    return merge({
      head: pullRequest.head,
      octokit,
      owner,
      pullRequestNumber: pullRequest.pullRequestNumber,
      repo,
    });
  }
  return { type: "nop" };
};

const autorebase = async ({
  event,
  label,
  octokit,
  owner,
  repo,
}: {
  event: Event;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<Action> => {
  debug("starting", { label, name: event.name });

  if (event.name === "check_run" || event.name === "status") {
    const sha: Sha =
      event.name === "check_run"
        ? event.payload.check_run.head_sha
        : event.payload.sha;
    const pullRequest = await findAutorebaseablePullRequestMatchingSha({
      label,
      octokit,
      owner,
      repo,
      sha,
    });

    if (pullRequest) {
      debug("autorebaseable pull request matching sha", pullRequest);
      if (pullRequest.mergeableState === "clean") {
        return merge({
          head: pullRequest.head,
          octokit,
          owner,
          pullRequestNumber: pullRequest.pullRequestNumber,
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
            event.payload.label.name === label))
      ) {
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
      pullRequest.mergeableState === "clean"
    ) {
      return merge({
        head: pullRequest.head,
        octokit,
        owner,
        pullRequestNumber: pullRequest.pullRequestNumber,
        repo,
      });
    }
  }

  return { type: "nop" };
};

export { Action, autorebase, Event };
