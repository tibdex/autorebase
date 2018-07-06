// @flow strict

import type { Github } from "@octokit/rest";
import {
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  deleteReference,
} from "@tibdex/shared-internals";
import createDebug from "debug";
import { rebasePullRequest } from "github-rebase";

import { name as packageName } from "../package";

const debug = createDebug(packageName);

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
  head: Reference,
  mergeableState: MergeableState,
  number: PullRequestNumber,
  rebaseable: boolean,
};

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
        mergeable_state,
        rebaseable,
        number,
      },
    }) => ({
      head,
      mergeableState: mergeable_state,
      number,
      rebaseable,
    })
  );
};

const organizePullRequests = pullRequests => {
  const rebasablePullRequests = pullRequests.filter(
    ({ mergeableState, rebaseable }) =>
      (mergeableState === "behind" || mergeableState === "clean") && rebaseable
  );
  const pullRequestToMerge = rebasablePullRequests.find(
    ({ mergeableState }) => mergeableState === "clean"
  );
  const [pullRequestToRebase] = rebasablePullRequests;
  return {
    pullRequestToMerge,
    pullRequestToRebase,
    rebasablePullRequests,
  };
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

const rebase = async ({ number, octokit, owner, repo }) => {
  debug("rebasing", number);
  await rebasePullRequest({
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
    rebasablePullRequests,
  } = organizePullRequests(pullRequests);
  debug("pull requests", {
    pullRequests,
    pullRequestToMerge,
    pullRequestToRebase,
    rebasablePullRequests,
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

export default autorebase;
