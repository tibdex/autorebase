// @flow strict

import type { Github } from "@octokit/rest";
import {
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchReferenceSha,
  updateReference,
  withTemporaryReference,
} from "@tibdex/shared-internals";
import createDebug from "debug";

import { name as packageName } from "../package";

const merge = async ({ base, commit, octokit, owner, repo }) => {
  const {
    data: {
      commit: {
        tree: { sha },
      },
    },
  } = await octokit.repos.merge({
    base,
    commit_message: `Merge ${commit} into ${base}`,
    head: commit,
    owner,
    repo,
  });
  return sha;
};

const createCommitWithDifferentTree = async ({
  commit,
  octokit,
  owner,
  parent,
  repo,
  tree,
}) => {
  const {
    data: { author, committer, message },
  } = await octokit.gitdata.getCommit({
    commit_sha: commit,
    owner,
    repo,
  });
  const {
    data: { sha },
  } = await octokit.gitdata.createCommit({
    author,
    committer,
    message,
    owner,
    parents: [parent],
    repo,
    // No PGP signature support for now.
    // See https://developer.github.com/v3/git/commits/#create-a-commit.
    tree,
  });
  return sha;
};

const cherryPickCommit = async ({
  commit,
  head: { ref, sha },
  octokit,
  owner,
  repo,
}) => {
  const tree = await merge({ base: ref, commit, octokit, owner, repo });
  const createdCommit = await createCommitWithDifferentTree({
    commit,
    octokit,
    owner,
    parent: sha,
    repo,
    tree,
  });
  await updateReference({
    // Overwrite the merge commit and its parent on the branch by a single commit.
    // The result will be equivalent to what would have happened with a fast-forward merge.
    force: true,
    octokit,
    owner,
    ref,
    repo,
    sha: createdCommit,
  });
  return createdCommit;
};

const cherryPickCommitsOnReference = ({
  commits,
  debug,
  head,
  octokit,
  owner,
  ref,
  repo,
}) =>
  commits.reduce(async (previousCherryPick, commit) => {
    const sha = await previousCherryPick;
    debug("cherry-picking", { commit, ref, sha });
    return cherryPickCommit({
      commit,
      head: { ref, sha },
      octokit,
      owner,
      repo,
    });
  }, Promise.resolve(head));

const cherryPickCommits = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  commits,
  head,
  octokit,
  owner,
  repo,
}: {
  _intercept?: ({ headInitialSha: Sha }) => Promise<void>,
  commits: Array<Sha>,
  head: Reference,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Sha> => {
  const debug = createDebug(packageName);
  debug("starting", { commits, head, owner, repo });
  const headInitialSha = await fetchReferenceSha({
    octokit,
    owner,
    ref: head,
    repo,
  });
  await _intercept({ headInitialSha });
  return withTemporaryReference({
    action: async temporaryRef => {
      debug({ temporaryRef });
      const newSha = await cherryPickCommitsOnReference({
        commits,
        debug,
        head: headInitialSha,
        octokit,
        owner,
        ref: temporaryRef,
        repo,
      });
      debug("updating reference with new SHA", newSha);
      await updateReference({
        // Make sure it's a fast-forward update.
        force: false,
        octokit,
        owner,
        ref: head,
        repo,
        sha: newSha,
      });
      debug("reference updated");
      return newSha;
    },
    octokit,
    owner,
    ref: `cherry-pick-${head}`,
    repo,
    sha: headInitialSha,
  });
};

export default cherryPickCommits;
