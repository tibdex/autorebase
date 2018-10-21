import * as assert from "assert";

import * as Octokit from "@octokit/rest";
import * as createDebug from "debug";
import {
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
} from "shared-github-internals/lib/git";

// tslint:disable-next-line:no-var-requires (otherwise we get the error TS2497).
const promiseRetry = require("promise-retry");

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
  base: Reference;
  head: Reference;
  labeledAndOpenedAndRebaseable: boolean;
  mergeableState: MergeableState;
  merged: boolean;
  pullRequestNumber: PullRequestNumber;
  sha: Sha;
};

type PullRequestPayload = {
  base: { ref: Reference };
  closed_at: null | string;
  head: { ref: Reference; sha: Sha };
  labels: Array<{ name: LabelName }>;
  mergeable_state: MergeableState;
  merged: boolean;
  number: PullRequestNumber;
  rebaseable: boolean;
};

const debug = createDebug("autorebase");

const getPullRequestInfo = ({
  label,
  pullRequest: {
    base: { ref: base },
    closed_at: closedAt,
    head: { ref: head, sha },
    labels,
    mergeable_state: mergeableState,
    merged,
    number: pullRequestNumber,
    rebaseable,
  },
}: {
  label: LabelName;
  pullRequest: PullRequestPayload;
}): PullRequestInfo => ({
  base,
  head,
  labeledAndOpenedAndRebaseable:
    labels.map(({ name }) => name).includes(label) &&
    closedAt === null &&
    rebaseable,
  mergeableState,
  merged,
  pullRequestNumber,
  sha,
});

const isMergeableStateKnown = ({
  closed_at: closedAt,
  mergeable_state: mergeableState,
}: PullRequestPayload) => closedAt !== null || mergeableState !== "unknown";

const checkKnownMergeableState = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<PullRequestPayload> => {
  const { data: pullRequest } = await octokit.pullRequests.get({
    number: pullRequestNumber,
    owner,
    repo,
  });
  // @ts-ignore mergeable_state is missing in Octokit's type.
  const { closed_at: closedAt, mergeable_state: mergeableState } = pullRequest;
  debug("mergeable state", { closedAt, mergeableState, pullRequestNumber });
  // @ts-ignore mergeable_state is missing in Octokit's type.
  assert(isMergeableStateKnown(pullRequest));
  // @ts-ignore our PullRequestPayload is simplified.
  return pullRequest;
};

const waitForKnownMergeableState = ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<PullRequestPayload> =>
  promiseRetry(
    async (retry: (error: any) => void) => {
      try {
        return await checkKnownMergeableState({
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
      } catch (error) {
        debug("retrying to know mergeable state", pullRequestNumber);
        return retry(error);
      }
    },
    { minTimeout: 500 },
  );

const getPullRequestInfoWithKnownMergeableState = async ({
  label,
  octokit,
  owner,
  pullRequest,
  repo,
}: {
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequest: PullRequestPayload;
  repo: RepoName;
}) => {
  if (isMergeableStateKnown(pullRequest)) {
    return getPullRequestInfo({ label, pullRequest });
  }
  const pullRequestWithKnownMergeableState = await waitForKnownMergeableState({
    octokit,
    owner,
    pullRequestNumber: pullRequest.number,
    repo,
  });
  return getPullRequestInfo({
    label,
    pullRequest: pullRequestWithKnownMergeableState,
  });
};

const getPullRequestNumbers = (response: Octokit.AnyResponse) =>
  response.data.items.map((item: any) => item.number);

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
  extraSearchQualifiers: string;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  predicate: (pullRequestInfo: PullRequestInfo) => boolean;
  repo: RepoName;
}): Promise<PullRequestInfo | null> => {
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
    const pullRequestNumbers = getPullRequestNumbers(response);
    debug({ pullRequestNumbers });
    const initialPromise = Promise.resolve(null);
    const matchingPullRequest = await pullRequestNumbers.reduce(
      async (
        promise: Promise<PullRequestInfo | null>,
        pullRequestNumber: PullRequestNumber,
      ) => {
        debug({ pullRequestNumber });
        const result = await promise;
        if (result) {
          return result;
        }
        const { data } = await octokit.pullRequests.get({
          number: pullRequestNumber,
          owner,
          repo,
        });
        debug("after octokit.pullRequests.get");
        const pullRequest = await getPullRequestInfoWithKnownMergeableState({
          label,
          octokit,
          owner,
          // @ts-ignore our PullRequestPayload is simplified.
          pullRequest: data,
          repo,
        });
        debug({ pullRequest });
        return predicate(pullRequest) ? pullRequest : null;
      },
      initialPromise,
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
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  sha: Sha;
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
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  action: () => Promise<void>;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  try {
    debug("acquiring lock", pullRequestNumber);
    await octokit.issues.removeLabel({
      name: label,
      number: pullRequestNumber,
      owner,
      repo,
    });
  } catch (error) {
    debug("lock already acquired by another process", pullRequestNumber);
    return false;
  }

  try {
    debug("lock acquired", pullRequestNumber);
    await action();
    return true;
  } finally {
    debug("releasing lock", pullRequestNumber);
    await octokit.issues.addLabels({
      labels: [label],
      number: pullRequestNumber,
      owner,
      repo,
    });
    debug("lock released", pullRequestNumber);
  }
};

export {
  debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  LabelName,
  MergeableState,
  PullRequestInfo,
  PullRequestPayload,
  waitForKnownMergeableState,
  withLabelLock,
};
