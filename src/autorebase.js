// @flow strict

import type { Github } from "@octokit/rest";
import createDebug from "debug";
import { rebasePullRequest } from "github-rebase";
import {
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  deleteReference,
} from "shared-github-internals/lib/git";

import { name as packageName } from "../package";

type LabelName = string;

type Options = {
  // If truthy, pull requests without this label will be ignored.
  label?: LabelName,
};

type Action =
  | {| number: PullRequestNumber, type: "merge" |}
  | {| number: PullRequestNumber, type: "rebase" |}
  | {| type: "nop" |};

// This property is not documented but after some investigation,
// the meaning of each possible value is:
type MergeableState =
  // The pull request is not up-to-date anymore: the base branched has moved.
  | "behind"
  // The pull request is up-to-date but some branch protections prevent it to be merged.
  | "blocked"
  // The pull request is up-to-date and can be merged.
  | "clean"
  // There are Git conflicts that prevent the branch to be merged or rebased.
  | "dirty"
  // GitHub doesn't know the state of the pull request yet.
  | "unknown"
  // The pull request is mergeable but in a pending or failed state.
  | "unstable";

type PullRequest = {
  alreadyBeingRebased: boolean,
  head: Reference,
  mergeableState: MergeableState,
  number: PullRequestNumber,
  rebaseable: boolean,
};

// Label used to flag pull requests that are being rebased.
// Autorebase can be called multiple times in a short period of time,
// especially since it listens to push events and that the rebase process triggers lots of them.
// It's important to ensure that these batches of calls don't end-up in concurrent rebase of the same pull request.
// Otherwise, Autorebase would be stuck in an infinite loop.
// To prevent this from happening, we flag pull requests being rebased with a label.
// Subsequent Autorebase calls will make sure not to try to rebase a pull request with this label already attached.
const rebasingLabel = "autorebasing";

const debug = createDebug(packageName);

const getPullRequestNumbers = response =>
  response.data.items.map(({ number }) => number);

const fetchPullRequests = async ({
  label,
  octokit,
  owner,
  repo,
}): Promise<Array<PullRequest>> => {
  // Use the search endpoint to be able to filter on labels when needed.
  let response = await octokit.search.issues({
    order: "asc",
    // eslint-disable-next-line id-length
    q: `is:pr is:open${
      label == null ? ` ` : ` label:"${label}" `
    }repo:${owner}/${repo}`,
    sort: "created",
  });
  const numbers = getPullRequestNumbers(response);
  while (octokit.hasNextPage(response)) {
    // Pagination is a legit use-case for using await in loops.
    // See https://github.com/octokit/rest.js#pagination
    // eslint-disable-next-line no-await-in-loop
    response = await octokit.getNextPage(response);
    numbers.push(...getPullRequestNumbers(response));
  }
  const responses = await Promise.all(
    numbers.map(number =>
      octokit.pullRequests.get({
        number,
        owner,
        repo,
      })
    )
  );
  return responses.map(
    ({
      data: {
        head: { ref: head },
        labels,
        mergeable_state,
        rebaseable,
        number,
      },
    }) => ({
      alreadyBeingRebased: labels.some(({ name }) => name === rebasingLabel),
      head,
      mergeableState: mergeable_state,
      number,
      rebaseable,
    })
  );
};

const getPullRequestToRebaseOrMerge = (
  pullRequests
): { pullRequestToMerge?: PullRequest, pullRequestToRebase?: PullRequest } => {
  const rebaseablePullRequests = pullRequests.filter(
    ({ rebaseable }) => rebaseable
  );
  const pullRequestToMerge = rebaseablePullRequests.find(
    ({ mergeableState }) => mergeableState === "clean"
  );
  if (pullRequestToMerge) {
    return { pullRequestToMerge };
  }
  const pullRequestToRebase = rebaseablePullRequests.find(
    ({ alreadyBeingRebased, mergeableState }) =>
      !alreadyBeingRebased && mergeableState === "behind"
  );
  return pullRequestToRebase ? { pullRequestToRebase } : {};
};

const merge = async ({ head, number, octokit, owner, repo }) => {
  debug("merging", number);
  await octokit.pullRequests.merge({
    merge_method: "rebase",
    number,
    owner,
    repo,
  });
  debug("merged");
  debug("deleting reference", head);
  await deleteReference({ octokit, owner, ref: head, repo });
  debug("reference deleted");
  return {
    number,
    type: "merge",
  };
};

const withRebasingLabel = async ({ action, number, octokit, owner, repo }) => {
  debug("adding rebasing label", number);
  await octokit.issues.addLabels({
    labels: [rebasingLabel],
    number,
    owner,
    repo,
  });

  try {
    return await action();
  } finally {
    debug("removing rebasing label", number);
    await octokit.issues.removeLabel({
      name: rebasingLabel,
      number,
      owner,
      repo,
    });
  }
};

const rebase = async ({ number, octokit, owner, repo }) => {
  debug("rebasing", number);
  await withRebasingLabel({
    action: () =>
      rebasePullRequest({
        number,
        octokit,
        owner,
        repo,
      }),
    number,
    octokit,
    owner,
    repo,
  });
  debug("rebased");
  return {
    number,
    type: "rebase",
  };
};

const autorebase = async ({
  octokit,
  options = { label: "autorebase" },
  owner,
  repo,
}: {
  octokit: Github,
  options?: Options,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Action> => {
  debug("starting", { options, owner, repo });
  const pullRequests = await fetchPullRequests({
    label: options.label,
    octokit,
    owner,
    repo,
  });
  const {
    pullRequestToMerge,
    pullRequestToRebase,
  } = getPullRequestToRebaseOrMerge(pullRequests);
  debug("pull requests", {
    pullRequests,
    pullRequestToMerge,
    pullRequestToRebase,
  });
  if (pullRequestToMerge) {
    return merge({
      head: pullRequestToMerge.head,
      number: pullRequestToMerge.number,
      octokit,
      owner,
      repo,
    });
  }
  if (pullRequestToRebase) {
    return rebase({ number: pullRequestToRebase.number, octokit, owner, repo });
  }
  debug("nothing to do");
  return { type: "nop" };
};

export { rebasingLabel };

export default autorebase;
