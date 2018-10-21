import * as Octokit from "@octokit/rest";
import {
  fetchReferenceSha,
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
} from "shared-github-internals/lib/git";

import { Event } from "./autorebase";
import { LabelName, MergeableState, PullRequestPayload } from "./utils";

type PullRequestPartialInfo = {
  base?: Reference;
  head?: Reference;
  labeledAndOpenedAndRebaseable?: boolean;
  mergeableState?: MergeableState;
  merged?: boolean;
  pullRequestNumber?: PullRequestNumber;
  sha?: Sha;
};

type RemoveBranchProtection = () => Promise<void>;

const createStatus = async ({
  error,
  octokit,
  owner,
  ref,
  repo,
}: {
  error?: boolean;
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
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
    pullRequestNumber,
    sha,
  },
}: {
  label?: LabelName;
  pullRequest: PullRequestPartialInfo;
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
  number: Number(pullRequestNumber),
  rebaseable: Boolean(labeledAndOpenedAndRebaseable),
});

const getApprovedReviewPullRequestEvent = ({
  label,
  pullRequest,
}: {
  label: LabelName;
  pullRequest: PullRequestPartialInfo;
}): Event => ({
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
  label: LabelName;
  pullRequest: PullRequestPartialInfo;
}): Event => ({
  name: "pull_request",
  payload: {
    action: "labeled",
    label: { name: label },
    pull_request: getPullRequestPayload({ label, pullRequest }),
  },
});

const getMergedPullRequestEvent = (base: Reference): Event => ({
  name: "pull_request",
  payload: {
    action: "closed",
    pull_request: getPullRequestPayload({
      pullRequest: { base, labeledAndOpenedAndRebaseable: false, merged: true },
    }),
  },
});

const getStatusEvent = (sha: Sha): Event => ({
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
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoOwner;
}): Promise<RemoveBranchProtection> => {
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
  RemoveBranchProtection,
};
