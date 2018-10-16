// @flow strict

import type { Github } from "@octokit/rest";
import {
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchReferenceSha,
} from "shared-github-internals/lib/git";

import {
  type LabelName,
  type MergeableState,
  type PullRequestPayload,
} from "../src/utils";

type PullRequestPartialInfo = {
  base?: Reference,
  head?: Reference,
  labeledAndOpenedAndRebaseable?: boolean,
  mergeableState?: MergeableState,
  merged?: boolean,
  number?: PullRequestNumber,
  sha?: Sha,
};

const createStatus = async ({
  error,
  octokit,
  owner,
  ref,
  repo,
}: {
  error?: boolean,
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
}) => {
  const sha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
  await octokit.repos.createStatus({
    owner,
    repo,
    sha,
    state: error === true ? "error" : "success",
  });
  return sha;
};

const getPullRequestPayload = ({
  label,
  pullRequest: {
    base,
    head,
    labeledAndOpenedAndRebaseable,
    mergeableState,
    merged,
    number,
    sha,
  },
}: {
  label?: LabelName,
  pullRequest: PullRequestPartialInfo,
}): PullRequestPayload => ({
  base: { ref: String(base) },
  closed_at: labeledAndOpenedAndRebaseable === true ? null : "some unused date",
  head: {
    ref: String(head),
    sha: String(sha),
  },
  labels:
    labeledAndOpenedAndRebaseable === true ? [{ name: String(label) }] : [],
  mergeable_state:
    typeof mergeableState === "string" ? mergeableState : "unknown",
  merged: labeledAndOpenedAndRebaseable === true ? false : Boolean(merged),
  number: Number(number),
  rebaseable: Boolean(labeledAndOpenedAndRebaseable),
});

const getApprovedReviewPullRequestEvent = ({
  label,
  pullRequest,
}: {
  label: LabelName,
  pullRequest: PullRequestPartialInfo,
}) => ({
  name: "pull_request_review",
  payload: {
    action: "submitted",
    pull_request: getPullRequestPayload({ label, pullRequest }),
  },
});

const getLabeledPullRequestEvent = ({
  label,
  pullRequest,
}: {
  label: LabelName,
  pullRequest: PullRequestPartialInfo,
}) => ({
  name: "pull_request",
  payload: {
    action: "labeled",
    label: { name: label },
    pull_request: getPullRequestPayload({ label, pullRequest }),
  },
});

const getMergedPullRequestEvent = (base: Reference) => ({
  name: "pull_request",
  payload: {
    action: "closed",
    pull_request: getPullRequestPayload({
      pullRequest: { base, labeledAndOpenedAndRebaseable: false, merged: true },
    }),
  },
});

const getStatusEvent = (sha: Sha) => ({
  name: "status",
  payload: {
    sha,
  },
});

const protectBranch = async ({
  octokit,
  owner,
  ref: branch,
  repo,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoOwner,
}) => {
  await octokit.repos.updateBranchProtection({
    branch,
    enforce_admins: true,
    owner,
    repo,
    required_pull_request_reviews: null,
    required_status_checks: { contexts: ["default"], strict: true },
    restrictions: null,
  });
  return async () => {
    await octokit.repos.removeBranchProtection({
      branch,
      owner,
      repo,
    });
  };
};

export {
  createStatus,
  getApprovedReviewPullRequestEvent,
  getLabeledPullRequestEvent,
  getMergedPullRequestEvent,
  getStatusEvent,
  protectBranch,
};
