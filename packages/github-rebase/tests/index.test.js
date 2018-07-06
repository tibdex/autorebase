// @flow strict

import { fetchReferenceSha, updateReference } from "@tibdex/shared-internals";
import { createTestContext } from "@tibdex/shared-internals/tests/context";
import {
  createCommitFromLinesAndMessage,
  createPullRequest,
  createReferences,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
} from "@tibdex/shared-internals/tests/git";

import { rebasePullRequest } from "../src";

let octokit, owner, repo;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe("nominal behavior", () => {
  const [initial, feature1st, feature2nd, master1st, master2nd] = [
    "initial",
    "feature 1st",
    "feature 2nd",
    "master 1st",
    "master 2nd",
  ];

  const [
    initialCommit,
    feature1stCommit,
    feature2ndCommit,
    master1stCommit,
    master2ndCommit,
  ] = [
    {
      lines: [initial, initial, initial, initial],
      message: initial,
    },
    {
      lines: [feature1st, initial, initial, initial],
      message: feature1st,
    },
    {
      lines: [feature1st, feature2nd, initial, initial],
      message: feature2nd,
    },
    {
      lines: [initial, initial, master1st, initial],
      message: master1st,
    },
    {
      lines: [initial, initial, master1st, master2nd],
      message: master2nd,
    },
  ];

  const state = {
    initialCommit,
    refsCommits: {
      feature: [feature1stCommit, feature2ndCommit],
      master: [master1stCommit, master2ndCommit],
    },
  };

  let closePullRequest, deleteReferences, number, refsDetails, sha;

  beforeAll(async () => {
    ({ deleteReferences, refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));
    ({ closePullRequest, number } = await createPullRequest({
      base: refsDetails.master.ref,
      head: refsDetails.feature.ref,
      octokit,
      owner,
      repo,
    }));
    sha = await rebasePullRequest({
      number,
      octokit,
      owner,
      repo,
    });
  }, 20000);

  afterAll(async () => {
    await closePullRequest();
    await deleteReferences();
  });

  test("returned sha is the actual feature ref sha", async () => {
    const actualRefSha = await fetchReferenceSha({
      octokit,
      owner,
      ref: refsDetails.feature.ref,
      repo,
    });
    expect(actualRefSha).toBe(sha);
  });

  test("commits on the feature ref are the expected ones", async () => {
    const actualCommits = await fetchReferenceCommitsFromSha({
      octokit,
      owner,
      repo,
      sha,
    });
    expect(actualCommits).toEqual([
      initialCommit,
      master1stCommit,
      master2ndCommit,
      {
        lines: [feature1st, initial, master1st, master2nd],
        message: feature1st,
      },
      {
        lines: [feature1st, feature2nd, master1st, master2nd],
        message: feature2nd,
      },
    ]);
  });
});

describe("atomicity", () => {
  describe("one of the commits cannot be cherry-picked", () => {
    const [initial, feature1st, master1st, master2nd] = [
      "initial",
      "feature 1st",
      "master 1st",
      "master 2nd",
    ];

    const [initialCommit, feature1stCommit] = [
      {
        lines: [initial, initial],
        message: initial,
      },
      {
        lines: [feature1st, initial],
        message: feature1st,
      },
    ];

    let closePullRequest, deleteReferences, number, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: {
          initialCommit,
          refsCommits: {
            feature: [feature1stCommit],
            master: [
              {
                lines: [initial, master1st],
                message: master1st,
              },
              {
                lines: [master2nd, master1st],
                message: master2nd,
              },
            ],
          },
        },
      }));
      ({ closePullRequest, number } = await createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      }));
    }, 15000);

    afterAll(async () => {
      await closePullRequest();
      await deleteReferences();
    });

    test(
      "whole operation aborted",
      async () => {
        try {
          await rebasePullRequest({
            number,
            octokit,
            owner,
            repo,
          });
          throw new Error("The rebase should have failed");
        } catch (error) {
          expect(error.message).toMatch(/Merge conflict/);
          const featureCommits = await fetchReferenceCommits({
            octokit,
            owner,
            ref: refsDetails.feature.ref,
            repo,
          });
          expect(featureCommits).toEqual([initialCommit, feature1stCommit]);
        }
      },
      15000
    );
  });

  describe("the head reference changed", () => {
    const [initial, feature1st, feature2nd, master1st] = [
      "initial",
      "feature 1st",
      "feature 2nd",
      "master 1st",
    ];

    const [initialCommit, feature1stCommit, feature2ndCommit] = [
      {
        lines: [initial, initial],
        message: initial,
      },
      {
        lines: [feature1st, initial],
        message: feature1st,
      },
      {
        lines: [feature1st, feature2nd],
        message: feature2nd,
      },
    ];

    let closePullRequest, deleteReferences, number, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: {
          initialCommit,
          refsCommits: {
            feature: [feature1stCommit],
            master: [
              {
                lines: [initial, master1st],
                message: master1st,
              },
            ],
          },
        },
      }));
      ({ closePullRequest, number } = await createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      }));
    }, 15000);

    afterAll(async () => {
      await closePullRequest();
      await deleteReferences();
    });

    test(
      "whole operation aborted",
      async () => {
        try {
          await rebasePullRequest({
            _intercept: async ({ headInitialSha }) => {
              const newCommit = await createCommitFromLinesAndMessage({
                commit: feature2ndCommit,
                octokit,
                owner,
                parent: headInitialSha,
                repo,
              });
              await updateReference({
                force: false,
                octokit,
                owner,
                ref: refsDetails.feature.ref,
                repo,
                sha: newCommit,
              });
            },
            number,
            octokit,
            owner,
            repo,
          });
          throw new Error("The rebase should have failed");
        } catch (error) {
          expect(error.message).toMatch(
            /Rebase aborted because the head branch changed/
          );
          const featureCommits = await fetchReferenceCommits({
            octokit,
            owner,
            ref: refsDetails.feature.ref,
            repo,
          });
          expect(featureCommits).toEqual([
            initialCommit,
            feature1stCommit,
            feature2ndCommit,
          ]);
        }
      },
      15000
    );
  });
});
