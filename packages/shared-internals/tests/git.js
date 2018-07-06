// @flow strict

import { type Github } from "@octokit/rest";

import {
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
  createTemporaryReference,
  fetchReferenceSha,
} from "..";

type CommitLines = Array<string>;

type CommitMessage = string;

type Commit = { lines: CommitLines, message: CommitMessage };

type ReferenceState = Array<Commit>;

type RepoState = {
  initialCommit: Commit,
  refsCommits: {
    [Reference]: ReferenceState,
  },
};

const eol = "\n";
const lineSeparator = `${eol}${eol}`;
const filename = "file.txt";

const getContent = lines => lines.join(lineSeparator);
const getLines = content => content.split(lineSeparator);

const createBlob = async ({ content, octokit, owner, repo }) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createBlob({
    content,
    owner,
    repo,
  });
  return sha;
};

const createTree = async ({ blob, octokit, owner, repo }) => {
  const {
    data: { sha: treeSha },
  } = await octokit.gitdata.createTree({
    owner,
    repo,
    tree: [
      {
        mode: "100644",
        path: filename,
        sha: blob,
        type: "blob",
      },
    ],
  });
  return treeSha;
};

const createCommit = async ({
  message,
  octokit,
  owner,
  parent,
  repo,
  tree,
}) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createCommit({
    message,
    owner,
    parents: parent == null ? [] : [parent],
    repo,
    tree,
  });
  return sha;
};

const createCommitFromLinesAndMessage = async ({
  commit: { lines, message },
  octokit,
  owner,
  parent,
  repo,
}: {
  commit: Commit,
  octokit: Github,
  owner: RepoOwner,
  parent?: Sha,
  repo: RepoName,
}): Promise<Sha> => {
  const content = getContent(lines);
  const blob = await createBlob({ content, octokit, owner, repo });
  const tree = await createTree({ blob, octokit, owner, repo });
  return createCommit({
    message,
    octokit,
    owner,
    parent,
    repo,
    tree,
  });
};

const createPullRequest = async ({
  base,
  head,
  octokit,
  owner,
  repo,
}: {
  base: Reference,
  head: Reference,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<{
  closePullRequest: () => Promise<void>,
  number: PullRequestNumber,
}> => {
  const {
    data: { number },
  } = await octokit.pullRequests.create({
    base,
    head,
    owner,
    repo,
    title: "Untitled",
  });
  return {
    async closePullRequest() {
      await octokit.pullRequests.update({
        number,
        owner,
        repo,
        state: "closed",
      });
    },
    number,
  };
};

const fetchContent = async ({ octokit, owner, repo, ref }) => {
  const {
    data: { content, encoding },
  } = await octokit.repos.getContent({
    owner,
    path: filename,
    ref,
    repo,
  });
  return Buffer.from(content, encoding).toString("utf8");
};

const fetchReferenceCommitsFromSha = async ({
  octokit,
  owner,
  repo,
  sha,
}: {
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
  sha: Sha,
}): Promise<ReferenceState> => {
  const content = await fetchContent({ octokit, owner, ref: sha, repo });

  const {
    data: { message, parents },
  } = await octokit.gitdata.getCommit({ commit_sha: sha, owner, repo });

  const commit = { lines: getLines(content), message };

  if (parents.length !== 0) {
    const commits = await fetchReferenceCommitsFromSha({
      octokit,
      owner,
      repo,
      sha: parents[0].sha,
    });
    return [...commits, commit];
  }

  return [commit];
};

const fetchReferenceCommits = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
}): Promise<ReferenceState> => {
  const sha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
  return fetchReferenceCommitsFromSha({ octokit, owner, repo, sha });
};

const getLatestSha = shas => shas[shas.length - 1];

const createReferences = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
  state: RepoState,
}): Promise<{
  deleteReferences: () => Promise<void>,
  refsDetails: { [Reference]: { ref: Reference, shas: Array<Sha> } },
}> => {
  const initialCommitSha = await createCommitFromLinesAndMessage({
    commit: initialCommit,
    octokit,
    owner,
    repo,
  });

  const refNames = Object.keys(refsCommits);

  const refsDetails = await Promise.all(
    refNames.map(async ref => {
      const shas = await refsCommits[ref].reduce(
        async (parentPromise, commit) => {
          const accumulatedShas = await parentPromise;
          const sha = await createCommitFromLinesAndMessage({
            commit,
            octokit,
            owner,
            parent: getLatestSha(accumulatedShas),
            repo,
          });
          return [...accumulatedShas, sha];
        },
        Promise.resolve([initialCommitSha])
      );
      const {
        deleteTemporaryReference: deleteReference,
        temporaryRef,
      } = await createTemporaryReference({
        octokit,
        owner,
        ref,
        repo,
        sha: getLatestSha(shas),
      });
      return { deleteReference, shas, temporaryRef };
    })
  );

  return {
    async deleteReferences() {
      await Promise.all(
        refsDetails.map(({ deleteReference }) => deleteReference())
      );
    },
    refsDetails: refsDetails.reduce(
      (acc, { shas, temporaryRef }, index) => ({
        ...acc,
        ...{ [refNames[index]]: { ref: temporaryRef, shas } },
      }),
      {}
    ),
  };
};

export {
  createCommitFromLinesAndMessage,
  createPullRequest,
  createReferences,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
};
