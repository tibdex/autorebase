// @flow strict

import assert from "assert";

import type { Github } from "@octokit/rest";
import createDebug from "debug";
import promiseRetry from "promise-retry";
import {
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
} from "shared-github-internals/lib/git";

import { name as packageName } from "../package";

type LabelName = string;

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

type PullRequestInfo = {
  base: Reference,
  head: Reference,
  labeledAndOpenedAndRebaseable: boolean,
  mergeableState: MergeableState,
  merged: boolean,
  number: PullRequestNumber,
  sha: Sha,
};

type PullRequestPayload = {
  base: { ref: Reference },
  closed_at: null | string,
  head: { ref: Reference, sha: Sha },
  labels: Array<{ name: LabelName }>,
  mergeable_state: MergeableState,
  merged: boolean,
  number: PullRequestNumber,
  rebaseable: boolean,
};

const debug = createDebug(packageName);

const getPullRequestInfo = ({
  label,
  pullRequest: {
    base: { ref: base },
    closed_at: closedAt,
    head: { ref: head, sha },
    labels,
    mergeable_state: mergeableState,
    merged,
    number,
    rebaseable,
  },
}: {
  label: LabelName,
  pullRequest: PullRequestPayload,
}): PullRequestInfo => ({
  base,
  head,
  labeledAndOpenedAndRebaseable:
    labels.map(({ name }) => name).includes(label) &&
    closedAt === null &&
    rebaseable,
  mergeableState,
  merged,
  number,
  sha,
});

const isMergeableStateKnown = ({
  closed_at: closedAt,
  mergeable_state: mergeableState,
}: PullRequestPayload) => closedAt !== null || mergeableState !== "unknown";

const checkKnownMergeableState = async ({ number, octokit, owner, repo }) => {
  const { data: pullRequest } = await octokit.pullRequests.get({
    number,
    owner,
    repo,
  });
  const { closed_at: closedAt, mergeable_state: mergeableState } = pullRequest;
  debug("mergeable state", { closedAt, mergeableState, number });
  assert(isMergeableStateKnown(pullRequest));
  return pullRequest;
};

const waitForKnownMergeableState = ({
  number,
  octokit,
  owner,
  repo,
}: {
  number: PullRequestNumber,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<PullRequestPayload> =>
  promiseRetry(
    async retry => {
      try {
        return await checkKnownMergeableState({ number, octokit, owner, repo });
      } catch (error) {
        debug("retrying to know mergeable state", number);
        return retry(error);
      }
    },
    { minTimeout: 500 }
  );

const getPullRequestInfoWithKnownMergeableState = async ({
  label,
  octokit,
  owner,
  pullRequest,
  repo,
}: {
  label: LabelName,
  octokit: Github,
  owner: RepoOwner,
  pullRequest: PullRequestPayload,
  repo: RepoName,
}) => {
  if (isMergeableStateKnown(pullRequest)) {
    return getPullRequestInfo({ label, pullRequest });
  }
  const pullRequestWithKnownMergeableState = await waitForKnownMergeableState({
    number: pullRequest.number,
    octokit,
    owner,
    repo,
  });
  return getPullRequestInfo({
    label,
    pullRequest: pullRequestWithKnownMergeableState,
  });
};

const getPullRequestNumbers = response =>
  response.data.items.map(({ number }) => number);

// Pagination is a legit use-case for using await in loops.
// See https://github.com/octokit/rest.js#pagination
/* eslint-disable no-await-in-loop */
const findOldestPullRequest = async ({
  extraSearchQualifiers,
  label,
  octokit,
  owner,
  predicate,
  repo,
}: {
  extraSearchQualifiers: string,
  label: LabelName,
  octokit: Github,
  owner: RepoOwner,
  predicate: PullRequestInfo => boolean,
  repo: RepoName,
}) => {
  const query = `is:pr is:open label:"${label}" repo:${owner}/${repo} ${extraSearchQualifiers}`;
  debug("searching oldest matching pull request", { query });

  // Use the search endpoint to be able to filter on labels.
  let response = await octokit.search.issues({
    order: "asc",
    // eslint-disable-next-line id-length
    q: query,
    sort: "created",
  });

  // Using a constant condition because the loop
  // exits as soon as a matching pull request is found
  // or when there is no more pages.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const numbers = getPullRequestNumbers(response);
    debug({ numbers });
    const matchingPullRequest = await numbers.reduce(
      async (promise, number) => {
        debug({ number });
        const result = await promise;
        if (result) {
          return result;
        }
        const { data } = await octokit.pullRequests.get({
          number,
          owner,
          repo,
        });
        debug("after octokit.pullRequests.get");
        const pullRequest = await getPullRequestInfoWithKnownMergeableState({
          label,
          octokit,
          owner,
          pullRequest: data,
          repo,
        });
        debug({ pullRequest });
        return predicate(pullRequest) ? pullRequest : null;
      },
      Promise.resolve()
    );
    if (matchingPullRequest) {
      return matchingPullRequest;
    }
    if (octokit.hasNextPage(response)) {
      debug("getting next page");
      response = await octokit.getNextPage(response);
    } else {
      return null;
    }
  }
};
/* eslint-enable no-await-in-loop */

const findAutorebaseablePullRequestMatchingSha = ({
  label,
  octokit,
  owner,
  repo,
  sha,
}: {
  label: LabelName,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
  sha: Sha,
}) =>
  findOldestPullRequest({
    extraSearchQualifiers: sha,
    label,
    octokit,
    owner,
    predicate: ({ labeledAndOpenedAndRebaseable, sha: pullRequestSha }) =>
      labeledAndOpenedAndRebaseable && pullRequestSha === sha,
    repo,
  });

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
}: {
  action: () => Promise<void>,
  label: LabelName,
  number: PullRequestNumber,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
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

export type { LabelName, MergeableState, PullRequestInfo, PullRequestPayload };

export {
  debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  waitForKnownMergeableState,
  withLabelLock,
};
