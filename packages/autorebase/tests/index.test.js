// @flow strict

import assert from "assert";

import { deleteReference, fetchReferenceSha } from "@tibdex/shared-internals";
import { createTestContext } from "@tibdex/shared-internals/tests/context";
import {
  createPullRequest,
  createReferences,
} from "@tibdex/shared-internals/tests/git";
import promiseRetry from "promise-retry";
import generateUuid from "uuid/v4";

import autorebase, { rebasingLabel } from "../src/autorebase";

const protectBranch = async ({ octokit, owner, ref: branch, repo }) => {
  await octokit.repos.updateBranchProtection({
    branch,
    enforce_admins: true,
    owner,
    repo,
    required_pull_request_reviews: null,
    required_status_checks: { contexts: ["default"], strict: true },
    restrictions: null,
  });
  return () =>
    octokit.repos.removeBranchProtection({
      branch,
      owner,
      repo,
    });
};

const checkKnownMergeableState = async ({ number, octokit, owner, repo }) => {
  const {
    data: { mergeable_state: mergeableState },
  } = await octokit.pullRequests.get({ number, owner, repo });
  assert.notEqual(mergeableState, "unknown");
};

const waitForKnownMergeableState = ({ number, octokit, owner, repo }) =>
  promiseRetry(
    async retry => {
      try {
        await checkKnownMergeableState({ number, octokit, owner, repo });
      } catch (error) {
        await retry(error);
      }
    },
    { minTimeout: 500 }
  );

const createSuccessStatus = async ({ octokit, owner, ref, repo }) => {
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
    state: "success",
  });
};

let octokit, owner, repo;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe("nominal behavior", () => {
  const options = {
    label: generateUuid(),
  };

  const [initial, master1st, featureA1st, featureB1st] = [
    "initial",
    "master 1st",
    "feature A 1st",
    "feature B 1st",
  ];

  const [
    initialCommit,
    master1stCommit,
    featureA1stCommit,
    featureB1stCommit,
  ] = [
    {
      lines: [initial, initial, initial],
      message: initial,
    },
    {
      lines: [master1st, initial, initial],
      message: master1st,
    },
    {
      lines: [initial, featureA1st, initial],
      message: featureA1st,
    },
    {
      lines: [initial, initial, featureB1st],
      message: featureB1st,
    },
  ];

  const state = {
    initialCommit,
    refsCommits: {
      featureA: [master1stCommit, featureA1stCommit],
      featureB: [featureB1stCommit],
      master: [master1stCommit],
    },
  };

  let numberA, numberB, refsDetails, removeMasterProtection;

  beforeAll(async () => {
    ({ refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));

    removeMasterProtection = await protectBranch({
      octokit,
      owner,
      ref: refsDetails.master.ref,
      repo,
    });

    [numberA, numberB] = await Promise.all(
      [refsDetails.featureA.ref, refsDetails.featureB.ref].map(async ref => {
        const [{ number }] = await Promise.all([
          createPullRequest({
            base: refsDetails.master.ref,
            head: ref,
            octokit,
            owner,
            repo,
          }),
          createSuccessStatus({ octokit, owner, ref, repo }),
        ]);
        await Promise.all([
          waitForKnownMergeableState({
            number,
            octokit,
            owner,
            repo,
          }),
          octokit.issues.addLabels({
            labels: [options.label],
            number,
            owner,
            repo,
          }),
        ]);
        return number;
      })
    );
  }, 25000);

  afterAll(async () => {
    await Promise.all([
      (async () => {
        await removeMasterProtection();
        await deleteReference({
          octokit,
          owner,
          ref: refsDetails.master.ref,
          repo,
        });
      })(),
      octokit.issues.deleteLabel({ name: options.label, owner, repo }),
    ]);
  });

  test(
    "merge feature A first, then rebase feature B and merge it once up-to-date",
    async () => {
      const firstAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(firstAutorebase).toEqual({ number: numberA, type: "merge" });

      await waitForKnownMergeableState({
        number: numberB,
        octokit,
        owner,
        repo,
      });
      const secondAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(secondAutorebase).toEqual({ number: numberB, type: "rebase" });

      await createSuccessStatus({
        octokit,
        owner,
        ref: refsDetails.featureB.ref,
        repo,
      });

      await waitForKnownMergeableState({
        number: numberB,
        octokit,
        owner,
        repo,
      });
      const thirdAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(thirdAutorebase).toEqual({ number: numberB, type: "merge" });

      const fourthAutorebase = await autorebase({ octokit, owner, repo });
      expect(fourthAutorebase).toEqual({ type: "nop" });
    },
    50000
  );
});

describe("rebasing label acts as a lock", () => {
  const options = {
    label: generateUuid(),
  };

  const [initial, master1st, feature1st] = [
    "initial",
    "master 1st",
    "feature 1st",
  ];

  const [initialCommit, master1stCommit, feature1stCommit] = [
    {
      lines: [initial, initial],
      message: initial,
    },
    {
      lines: [master1st, initial],
      message: master1st,
    },
    {
      lines: [initial, feature1st],
      message: feature1st,
    },
  ];

  const state = {
    initialCommit,
    refsCommits: {
      feature: [feature1stCommit],
      master: [master1stCommit],
    },
  };

  let number, refsDetails, removeMasterProtection;

  beforeAll(async () => {
    ({ refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));

    removeMasterProtection = await protectBranch({
      octokit,
      owner,
      ref: refsDetails.master.ref,
      repo,
    });

    [{ number }] = await Promise.all([
      createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      }),
      createSuccessStatus({
        octokit,
        owner,
        ref: refsDetails.feature.ref,
        repo,
      }),
    ]);

    await Promise.all([
      waitForKnownMergeableState({
        number,
        octokit,
        owner,
        repo,
      }),
      octokit.issues.addLabels({
        labels: [options.label],
        number,
        owner,
        repo,
      }),
    ]);
  }, 25000);

  afterAll(async () => {
    await Promise.all([
      (async () => {
        await removeMasterProtection();
        await deleteReference({
          octokit,
          owner,
          ref: refsDetails.master.ref,
          repo,
        });
      })(),
      octokit.issues.deleteLabel({ name: options.label, owner, repo }),
    ]);
  });

  test(
    "pull request is not rebased when it already has the rebasing label",
    async () => {
      await octokit.issues.addLabels({
        labels: [rebasingLabel],
        number,
        owner,
        repo,
      });
      const firstAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(firstAutorebase).toEqual({ type: "nop" });

      await octokit.issues.removeLabel({
        name: rebasingLabel,
        number,
        owner,
        repo,
      });
      const secondAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(secondAutorebase).toEqual({ number, type: "rebase" });

      await createSuccessStatus({
        octokit,
        owner,
        ref: refsDetails.feature.ref,
        repo,
      });
      await waitForKnownMergeableState({
        number,
        octokit,
        owner,
        repo,
      });
      const thirdAutorebase = await autorebase({
        octokit,
        options,
        owner,
        repo,
      });
      expect(thirdAutorebase).toEqual({ number, type: "merge" });

      const fourthAutorebase = await autorebase({ octokit, owner, repo });
      expect(fourthAutorebase).toEqual({ type: "nop" });
    },
    50000
  );
});
