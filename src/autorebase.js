// @flow strict

import type { Github } from "@octokit/rest";
import createDebug from "debug";
import rebasePullRequest from "github-rebase";
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
 * See https://developer.github.com/v4/enum/mergestatestatus/
 */
type MergeableState =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "unknown"
  | "unstable";

type PullRequest = {
  head: Reference,
  mergeableState: MergeableState,
  number: PullRequestNumber,
  rebaseable: boolean,
};

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
    ({ mergeableState }) => mergeableState === "behind"
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

// Autorebase can be called multiple times in a short period of time.
// It's better to ensure that these batches of calls don't end-up in concurrent rebase of the same pull request.
// To prevent this from happening, we use a label as a lock.
// Before Autorebase starts rebasing a pull request, it will acquire the lock by removing the label.
// Subsequent Autorebase calls won't be able to do the same thing because the GitHub REST API prevents removing a label that's not already there.
const withLabelLock = async ({
  action,
  label,
  number,
  octokit,
  owner,
  repo,
}) => {
  try {
    debug("acquiring lock", number);
    await octokit.issues.removeLabel({
      name: label,
      number,
      owner,
      repo,
    });
  } catch (error) {
    debug("lock already acquired by another process", number);
    return false;
  }

  try {
    debug("lock acquired", number);
    await action();
    return true;
  } finally {
    debug("releasing lock", number);
    await octokit.issues.addLabels({
      labels: [label],
      number,
      owner,
      repo,
    });
    debug("lock released", number);
  }
};

const rebase = async ({ label, number, octokit, owner, repo }) => {
  debug("rebasing", number);
  const rebased = await withLabelLock({
    action: () =>
      rebasePullRequest({
        number,
        octokit,
        owner,
        repo,
      }),
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

const autorebase = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  octokit,
  options = { label: "autorebase" },
  owner,
  repo,
}: {
  _intercept?: () => Promise<void>,
  octokit: Github,
  options?: Options,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Action> => {
  debug("starting", { options, owner, repo });
  const { label } = options;
  const pullRequests = await fetchPullRequests({
    label,
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
    await _intercept();
    return rebase({
      label,
      number: pullRequestToRebase.number,
      octokit,
      owner,
      repo,
    });
  }
  debug("nothing to do");
  return { type: "nop" };
};

export default autorebase;
