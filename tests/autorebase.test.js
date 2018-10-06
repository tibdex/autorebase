// @flow strict

import createDebug from "debug";
import { deleteReference } from "shared-github-internals/lib/git";
import { createTestContext } from "shared-github-internals/lib/tests/context";
import {
  createPullRequest,
  createReferences,
} from "shared-github-internals/lib/tests/git";
import generateUuid from "uuid/v4";

import { name as packageName } from "../package";
import autorebase from "../src/autorebase";
import { waitForKnownMergeableState } from "../src/utils";

import {
  createStatus,
  getApprovedReviewPullRequestEventAndPayload,
  getLabeledPullRequestEventAndPayload,
  getMergedPullRequestEventAndPayload,
  getStatusEventAndPayload,
  protectBranch,
} from "./utils";

const debug = createDebug(`${packageName}-test`);

const [initial, master1st] = ["initial", "master 1st"];

const debuggableStep = async (name, asyncAction) => {
  debug(`[start] ${name}`);
  try {
    await asyncAction();
    debug(`[done] ${name}`);
  } catch (error) {
    debug(`[failed] ${name}`);
    throw error;
  }
};

let octokit, owner, repo;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe("nominal behavior", () => {
  const label = generateUuid();
  const options = { label };

  const [featureA1st, featureB1st] = ["feature A 1st", "feature B 1st"];
  const featureA2nd = `fixup! ${featureA1st}`;

  const [
    initialCommit,
    master1stCommit,
    featureA1stCommit,
    featureA2ndCommit,
    featureB1stCommit,
  ] = [
    {
      lines: [initial, initial, initial, initial],
      message: initial,
    },
    {
      lines: [master1st, initial, initial, initial],
      message: master1st,
    },
    {
      lines: [initial, featureA1st, initial, initial],
      message: featureA1st,
    },
    {
      lines: [initial, featureA1st, featureA2nd, initial],
      message: featureA2nd,
    },
    {
      lines: [initial, initial, initial, featureB1st],
      message: featureB1st,
    },
  ];

  const state = {
    initialCommit,
    refsCommits: {
      featureA: [master1stCommit, featureA1stCommit, featureA2ndCommit],
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
        const [number] = await Promise.all([
          createPullRequest({
            base: refsDetails.master.ref,
            head: ref,
            octokit,
            owner,
            repo,
          }),
          createStatus({ octokit, owner, ref, repo }),
        ]);
        await Promise.all([
          waitForKnownMergeableState({
            number,
            octokit,
            owner,
            repo,
          }),
          octokit.issues.addLabels({
            labels: [label],
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
      octokit.issues.deleteLabel({ name: label, owner, repo }),
    ]);
  });

  test(
    "full story",
    async () => {
      await debuggableStep("feature A clean but autosquashed", async () => {
        const result = await autorebase({
          eventAndPayload: getLabeledPullRequestEventAndPayload({
            label,
            pullRequest: {
              labeledAndOpenedAndRebaseable: true,
              mergeableState: "clean",
              number: numberA,
            },
          }),
          octokit,
          options,
          owner,
          repo,
        });
        expect(result).toEqual({ number: numberA, type: "rebase" });
      });

      await debuggableStep(
        "feature B rebased because of error status on feature A",
        async () => {
          await waitForKnownMergeableState({
            number: numberA,
            octokit,
            owner,
            repo,
          });
          const featureASha = await createStatus({
            error: true,
            octokit,
            owner,
            ref: refsDetails.featureA.ref,
            repo,
          });
          const result = await autorebase({
            eventAndPayload: getStatusEventAndPayload(featureASha),
            octokit,
            options,
            owner,
            repo,
          });
          expect(result).toEqual({ number: numberB, type: "rebase" });
        }
      );

      await debuggableStep(
        "feature A merged after successful status",
        async () => {
          const featureASha = await createStatus({
            octokit,
            owner,
            ref: refsDetails.featureA.ref,
            repo,
          });
          await waitForKnownMergeableState({
            number: numberA,
            octokit,
            owner,
            repo,
          });
          const result = await autorebase({
            eventAndPayload: getStatusEventAndPayload(featureASha),
            octokit,
            options,
            owner,
            repo,
          });
          expect(result).toEqual({ number: numberA, type: "merge" });
        }
      );

      await debuggableStep(
        "feature B rebased after feature A merged",
        async () => {
          await waitForKnownMergeableState({
            number: numberB,
            octokit,
            owner,
            repo,
          });
          const result = await autorebase({
            eventAndPayload: getMergedPullRequestEventAndPayload(
              refsDetails.master.ref
            ),
            octokit,
            options,
            owner,
            repo,
          });
          expect(result).toEqual({ number: numberB, type: "rebase" });
        }
      );

      await debuggableStep(
        "feature B merged after review approval (with successful status)",
        async () => {
          await waitForKnownMergeableState({
            number: numberB,
            octokit,
            owner,
            repo,
          });
          await createStatus({
            octokit,
            owner,
            ref: refsDetails.featureB.ref,
            repo,
          });
          const {
            mergeable_state: mergeableState,
          } = await waitForKnownMergeableState({
            number: numberB,
            octokit,
            owner,
            repo,
          });
          const result = await autorebase({
            eventAndPayload: getApprovedReviewPullRequestEventAndPayload({
              label,
              pullRequest: {
                head: refsDetails.featureB.ref,
                labeledAndOpenedAndRebaseable: true,
                mergeableState,
                number: numberB,
              },
            }),
            octokit,
            options,
            owner,
            repo,
          });
          expect(result).toEqual({ number: numberB, type: "merge" });
        }
      );

      await debuggableStep("nothing to do after feature B merged", async () => {
        await waitForKnownMergeableState({
          number: numberB,
          octokit,
          owner,
          repo,
        });
        const result = await autorebase({
          eventAndPayload: getMergedPullRequestEventAndPayload(
            refsDetails.master.ref
          ),
          octokit,
          options,
          owner,
          repo,
        });
        expect(result).toEqual({ type: "nop" });
      });
    },
    60000
  );
});

describe("rebasing label acts as a lock", () => {
  const label = generateUuid();
  const options = { label };

  const feature1st = "feature1st";

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

    [number] = await Promise.all([
      createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      }),
      createStatus({
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
        labels: [label],
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
      octokit.issues.deleteLabel({ name: label, owner, repo }),
    ]);
  });

  test(
    "concurrent calls of Autorebase lead to only one rebase attempt",
    async () => {
      let bothReadyToRebase = false;
      let resolveOther;

      const concurrentAutorebaseAttempts = await Promise.all(
        new Array(2)
          .fill(() =>
            autorebase({
              _intercept() {
                if (!bothReadyToRebase) {
                  bothReadyToRebase = true;
                  return new Promise(resolve => {
                    resolveOther = resolve;
                  });
                }

                // Wait for a request to be made to GitHub before resolving the other call.
                // We need to do that because removing a label on a pull request is not a perfectly atomic lock.
                // Indeed, if two removal requests are made really close to one another (typically less than 10ms), GitHub will accept both of them.
                octokit.pullRequests
                  .get({ number, owner, repo })
                  .then(resolveOther);

                // Resolve this call immediately.
                return Promise.resolve();
              },
              eventAndPayload: getLabeledPullRequestEventAndPayload({
                label,
                pullRequest: {
                  labeledAndOpenedAndRebaseable: true,
                  mergeableState: "behind",
                  number,
                },
              }),
              octokit,
              options,
              owner,
              repo,
            })
          )
          .map(attemptRebase => attemptRebase())
      );

      // Check that only one instance actually attempted to rebase the pull request.
      expect(concurrentAutorebaseAttempts).toContainEqual({
        number,
        type: "abort",
      });
      expect(concurrentAutorebaseAttempts).toContainEqual({
        number,
        type: "rebase",
      });

      const newFeatureSha = await createStatus({
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
        eventAndPayload: getStatusEventAndPayload(newFeatureSha),
        octokit,
        options,
        owner,
        repo,
      });
      expect(thirdAutorebase).toEqual({ number, type: "merge" });

      const fourthAutorebase = await autorebase({
        eventAndPayload: getMergedPullRequestEventAndPayload(
          refsDetails.master.ref
        ),
        octokit,
        options,
        owner,
        repo,
      });
      expect(fourthAutorebase).toEqual({ type: "nop" });
    },
    40000
  );
});
