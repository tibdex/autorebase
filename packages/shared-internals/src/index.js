// @flow strict

import type { Github } from "@octokit/rest";
import generateUuid from "uuid/v4";

type PullRequestNumber = number;

/**
 * A Git reference name.
 */
type Reference = string;

type RepoName = string;

type RepoOwner = string;

/**
 * A Git SHA-1.
 */
type Sha = string;

const generateUniqueRef = (ref: Reference): Reference =>
  `${ref}-${generateUuid()}`;
const getHeadRef = (ref: Reference): Reference => `heads/${ref}`;
const getFullyQualifiedRef = (ref: Reference): Reference =>
  `refs/${getHeadRef(ref)}`;

const fetchReferenceSha = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
}): Promise<Sha> => {
  const {
    data: {
      object: { sha },
    },
  } = await octokit.gitdata.getReference({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
  return sha;
};

const updateReference = async ({
  force,
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  force: boolean,
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
  sha: Sha,
}): Promise<void> => {
  await octokit.gitdata.updateReference({
    force,
    owner,
    ref: getHeadRef(ref),
    repo,
    sha,
  });
};

const deleteReference = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
}): Promise<void> => {
  await octokit.gitdata.deleteReference({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
};

const createTemporaryReference = async ({
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
  sha: Sha,
}): Promise<{
  deleteTemporaryReference: () => Promise<void>,
  temporaryRef: Reference,
}> => {
  const temporaryRef = generateUniqueRef(ref);
  await octokit.gitdata.createReference({
    owner,
    ref: getFullyQualifiedRef(temporaryRef),
    repo,
    sha,
  });
  return {
    async deleteTemporaryReference() {
      await deleteReference({
        octokit,
        owner,
        ref: temporaryRef,
        repo,
      });
    },
    temporaryRef,
  };
};

const withTemporaryReference: <T>({
  action(Reference): Promise<T>,
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
  sha: Sha,
}) => Promise<T> = async ({ action, octokit, owner, ref, repo, sha }) => {
  const {
    deleteTemporaryReference,
    temporaryRef,
  } = await createTemporaryReference({
    octokit,
    owner,
    ref,
    repo,
    sha,
  });

  try {
    return await action(temporaryRef);
  } finally {
    await deleteTemporaryReference();
  }
};

export type { PullRequestNumber, Reference, RepoName, RepoOwner, Sha };

export {
  createTemporaryReference,
  deleteReference,
  fetchReferenceSha,
  generateUniqueRef,
  getHeadRef,
  updateReference,
  withTemporaryReference,
};
