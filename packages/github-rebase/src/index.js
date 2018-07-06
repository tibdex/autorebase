// @flow strict

import type { Github } from "@octokit/rest";
import {
  type PullRequestNumber,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchReferenceSha,
  updateReference,
  withTemporaryReference,
} from "@tibdex/shared-internals";
import createDebug from "debug";
import cherryPick from "github-cherry-pick";

import { name as packageName } from "../package";

const getCommitShas = response => response.data.map(({ sha }) => sha);

const fetchCommits = async ({ number, octokit, owner, repo }) => {
  let response = await octokit.pullRequests.getCommits({ number, owner, repo });
  const commits = getCommitShas(response);
  while (octokit.hasNextPage(response)) {
    // Pagination is a legit use-case for using await in loops.
    // See https://github.com/octokit/rest.js#pagination
    // eslint-disable-next-line no-await-in-loop
    response = await octokit.getNextPage(response);
    commits.push(...getCommitShas(response));
  }
  return commits;
};

const checkSameHead = async ({
  octokit,
  owner,
  ref,
  repo,
  sha: expectedSha,
}) => {
  const actualSha = await fetchReferenceSha({ octokit, owner, ref, repo });
  if (actualSha !== expectedSha) {
    throw new Error(
      [
        `Rebase aborted because the head branch changed.`,
        `The current SHA of ${ref} is ${actualSha} but it was expected to still be ${expectedSha}.`,
      ].join("\n")
    );
  }
};

const rebasePullRequest = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  number,
  octokit,
  owner,
  repo,
}: {
  _intercept?: ({ headInitialSha: Sha }) => Promise<void>,
  number: PullRequestNumber,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Sha> => {
  const debug = createDebug(packageName);
  debug("starting", { number, owner, repo });

  const {
    data: {
      base: { ref: baseRef },
      head: { ref: headRef, sha: headInitialSha },
    },
  } = await octokit.pullRequests.get({ number, owner, repo });
  // The SHA given by GitHub for the base branch is not always up to date.
  // A request is made to fetch the actual one.
  const baseInitialSha = await fetchReferenceSha({
    octokit,
    owner,
    ref: baseRef,
    repo,
  });
  const commits = await fetchCommits({ number, octokit, owner, repo });
  debug("commits", {
    baseInitialSha,
    commits,
    headInitialSha,
    headRef,
  });
  await _intercept({ headInitialSha });
  return withTemporaryReference({
    action: async temporaryRef => {
      debug({ temporaryRef });
      const newSha = await cherryPick({
        commits,
        head: temporaryRef,
        octokit,
        owner,
        repo,
      });
      await checkSameHead({
        octokit,
        owner,
        ref: headRef,
        repo,
        sha: headInitialSha,
      });
      debug("updating reference with new SHA", newSha);
      await updateReference({
        // Rebase operations are not fast-forwards.
        force: true,
        octokit,
        owner,
        ref: headRef,
        repo,
        sha: newSha,
      });
      debug("reference updated");
      return newSha;
    },
    octokit,
    owner,
    ref: `rebase-pull-request-${number}`,
    repo,
    sha: baseInitialSha,
  });
};

export { rebasePullRequest };
