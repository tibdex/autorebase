import * as Octokit from "@octokit/rest";
import * as createDebug from "debug";
import {
  PullRequestNumber,
  RepoName,
  RepoOwner,
} from "shared-github-internals/lib/git";
import {
  createPullRequest,
  createReferences,
  DeleteReferences,
  RefsDetails,
} from "shared-github-internals/lib/tests/git";
import * as generateUuid from "uuid/v4";

import { createApplicationFunction } from "./app";
import {
  createCheckOrStatus,
  createTestContext,
  DeleteProtectedBranch,
  protectBranch,
  StartServer,
  StopServer,
  waitForMockedHandlerCalls,
} from "./tests-utils";
import { LabelName, waitForKnownMergeableState } from "./utils";

const debug = createDebug("autorebase-test");

const [initial, master1st, feature1st] = [
  "initial",
  "master 1st",
  "feature1st",
];

const debuggableStep = async (
  name: string,
  asyncAction: () => Promise<void>,
) => {
  debug(`[start] ${name}`);
  try {
    await asyncAction();
    debug(`[done] ${name}`);
  } catch (error) {
    debug(`[failed] ${name}`);
    throw error;
  }
};

const getLabelNames = async (pullRequestNumber: PullRequestNumber) => {
  const { data: labels } = await octokit.issues.listLabelsOnIssue({
    number: pullRequestNumber,
    owner,
    repo,
  });
  return labels.map(({ name }) => name);
};

const getLastIssueComment = async (pullRequestNumber: PullRequestNumber) => {
  const { data: comments } = await octokit.issues.listComments({
    number: pullRequestNumber,
    owner,
    repo,
  });
  return comments[comments.length - 1].body;
};

const handleAction = jest.fn();
const handleEvent = jest.fn();
const label: LabelName = generateUuid();
let octokit: Octokit;
let owner: RepoOwner;
let repo: RepoName;
let startServer: StartServer;

beforeAll(async () => {
  ({ octokit, owner, repo, startServer } = await createTestContext(
    createApplicationFunction({ handleAction, handleEvent, label }),
  ));
});

beforeEach(() => {
  [handleAction, handleEvent].forEach(mock => {
    mock.mockReset();
    mock.mockImplementation(async arg => {
      debug("default mock implementation", { arg });
    });
  });
});

describe.each([["check"], ["status"]])("nominal behavior with %s", mode => {
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

  let pullRequestNumberA: PullRequestNumber;
  let pullRequestNumberB: PullRequestNumber;
  let refsDetails: RefsDetails;
  let deleteMasterBranch: DeleteProtectedBranch;
  let stopServer: StopServer;

  beforeAll(async () => {
    ({ refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));

    deleteMasterBranch = await protectBranch({
      octokit,
      owner,
      ref: refsDetails.master.ref,
      repo,
    });

    [pullRequestNumberA, pullRequestNumberB] = await Promise.all(
      [refsDetails.featureA.ref, refsDetails.featureB.ref].map(async ref => {
        const [pullRequestNumber] = await Promise.all([
          createPullRequest({
            base: refsDetails.master.ref,
            head: ref,
            octokit,
            owner,
            repo,
          }),
          createCheckOrStatus({ mode, octokit, owner, ref, repo }),
        ]);
        await waitForKnownMergeableState({
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
        return pullRequestNumber;
      }),
    );

    stopServer = startServer();
  }, 40000);

  afterAll(async () => {
    stopServer();

    await Promise.all([
      deleteMasterBranch(),
      octokit.issues.deleteLabel({ name: label, owner, repo }),
    ]);
  });

  test("full story", async () => {
    await debuggableStep(
      "feature A clean but autosquashing needed",
      async () => {
        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleAction,
            implementations: [
              async aAutosquashedAction => {
                debug({ aAutosquashedAction });
                expect(aAutosquashedAction).toEqual({
                  pullRequestNumber: pullRequestNumberA,
                  type: "rebase",
                });
              },
            ],
          }),
          octokit.issues.addLabels({
            labels: [label],
            number: pullRequestNumberA,
            owner,
            repo,
          }),
        ]);
      },
    );

    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber: pullRequestNumberA,
      repo,
    });

    await debuggableStep(
      "feature B rebased because of error status on feature A",
      async () => {
        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleEvent,
            implementations: [
              async bLabeledEvent => {
                debug({ bLabeledEvent });
                // Pretend that the pull request has actually been unlabeled
                // so that Autorebase will ignore it.
                // That's because we want to test that feature B will still get handled
                // because of an error status event on feature A.
                bLabeledEvent.payload.action = "unlabeled";

                await Promise.all([
                  waitForMockedHandlerCalls({
                    handler: handleAction,
                    implementations: [
                      async bRebasedAction => {
                        debug({ bRebasedAction });
                        expect(bRebasedAction).toEqual({
                          pullRequestNumber: pullRequestNumberB,
                          type: "rebase",
                        });
                      },
                    ],
                  }),
                  createCheckOrStatus({
                    error: true,
                    mode,
                    octokit,
                    owner,
                    ref: refsDetails.featureA.ref,
                    repo,
                  }),
                ]);
              },
            ],
          }),
          octokit.issues.addLabels({
            labels: [label],
            number: pullRequestNumberB,
            owner,
            repo,
          }),
        ]);
      },
    );

    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber: pullRequestNumberB,
      repo,
    });

    await debuggableStep(
      "feature A merged after successful status, then feature B rebased",
      async () => {
        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleAction,
            implementations: [
              async aMergedAction => {
                debug({ aMergedAction });
                expect(aMergedAction).toEqual({
                  pullRequestNumber: pullRequestNumberA,
                  type: "merge",
                });
              },
              async bRebasedAction => {
                debug({ bRebasedAction });
                expect(bRebasedAction).toEqual({
                  pullRequestNumber: pullRequestNumberB,
                  type: "rebase",
                });
              },
            ],
          }),
          createCheckOrStatus({
            mode,
            octokit,
            owner,
            ref: refsDetails.featureA.ref,
            repo,
          }),
        ]);
      },
    );

    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber: pullRequestNumberB,
      repo,
    });

    await debuggableStep(
      "feature B merged after review approval (with successful status)",
      async () => {
        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleEvent,
            implementations: [
              async bSuccessfulStatusEvent => {
                debug({ bSuccessfulStatusEvent });
                // Pretend that the pull request has actually been approved by a reviewer.
                // That's because that's the event type we want to test here and not the status one.
                // after an approved review status event.
                bSuccessfulStatusEvent.name = "pull_request_review";
                bSuccessfulStatusEvent.payload = {
                  action: "submitted",
                  pull_request: {
                    closed_at: null,
                    mergeable_state: "unknown",
                    number: pullRequestNumberB,
                  },
                };
              },
            ],
          }),
          waitForMockedHandlerCalls({
            handler: handleAction,
            implementations: [
              async bMergedAction => {
                debug({ bMergedAction });
                expect(bMergedAction).toEqual({
                  pullRequestNumber: pullRequestNumberB,
                  type: "merge",
                });
              },
            ],
          }),
          createCheckOrStatus({
            mode,
            octokit,
            owner,
            ref: refsDetails.featureB.ref,
            repo,
          }),
        ]);
      },
    );
  }, 150000);
});

describe("rebasing label acts as a lock", () => {
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

  let pullRequestNumber: PullRequestNumber;
  let refsDetails: RefsDetails;
  let deleteMasterBranch: DeleteProtectedBranch;
  let stopServer: StopServer;

  beforeAll(async () => {
    ({ refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));

    deleteMasterBranch = await protectBranch({
      octokit,
      owner,
      ref: refsDetails.master.ref,
      repo,
    });

    [pullRequestNumber] = await Promise.all([
      createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      }),
      createCheckOrStatus({
        mode: "check",
        octokit,
        owner,
        ref: refsDetails.feature.ref,
        repo,
      }),
    ]);

    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });

    stopServer = startServer();
  }, 25000);

  afterAll(async () => {
    stopServer();

    await Promise.all([
      deleteMasterBranch(),
      octokit.issues.deleteLabel({ name: label, owner, repo }),
    ]);
  });

  test("concurrent calls of Autorebase lead to only one rebase attempt", async () => {
    let unblockFirstCall: () => void;

    await Promise.all([
      waitForMockedHandlerCalls({
        handler: handleEvent,
        implementations: [
          async labeledEvent => {
            debug({ labeledEvent });
            await Promise.all([
              new Promise(innerResolve => {
                unblockFirstCall = innerResolve;
              }),
              octokit.issues.removeLabel({
                name: label,
                number: pullRequestNumber,
                owner,
                repo,
              }),
            ]);
          },
          async unlabeledEvent => {
            debug({ unlabeledEvent });
            await octokit.issues.addLabels({
              labels: [label],
              number: pullRequestNumber,
              owner,
              repo,
            });
          },
          async relabeledEvent => {
            debug({ relabeledEvent });
            // Wait for a request to be made to GitHub before resolving the other call.
            // We need to do that because removing a label on a pull request is not a perfectly atomic lock.
            // Indeed, if two removal requests are made really close to one another (typically less than 10ms), GitHub will accept both of them.
            octokit.pullRequests
              .get({
                number: pullRequestNumber,
                owner,
                repo,
              })
              .then(unblockFirstCall);
          },
        ],
      }),
      waitForMockedHandlerCalls({
        handler: handleAction,
        implementations: [
          async abortAction => {
            debug({ abortAction });
            expect(abortAction).toEqual({
              pullRequestNumber,
              type: "abort",
            });
          },
          async rebaseAction => {
            debug({ rebaseAction });
            expect(rebaseAction).toEqual({
              pullRequestNumber,
              type: "rebase",
            });
          },
        ],
      }),
      octokit.issues.addLabels({
        labels: [label],
        number: pullRequestNumber,
        owner,
        repo,
      }),
    ]);

    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });

    await Promise.all([
      waitForMockedHandlerCalls({
        handler: handleAction,
        implementations: [
          async mergeAction => {
            debug({ mergeAction });
            expect(mergeAction).toEqual({
              pullRequestNumber,
              type: "merge",
            });
          },
        ],
      }),
      createCheckOrStatus({
        mode: "check",
        octokit,
        owner,
        ref: refsDetails.feature.ref,
        repo,
      }),
    ]);
  }, 50000);
});

describe("rebase failed", () => {
  const [initialCommit, master1stCommit, feature1stCommit] = [
    {
      lines: [initial],
      message: initial,
    },
    {
      lines: [master1st],
      message: master1st,
    },
    {
      lines: [feature1st],
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

  let deleteReferences: DeleteReferences;
  let pullRequestNumber: PullRequestNumber;
  let refsDetails: RefsDetails;
  let stopServer: StopServer;

  beforeAll(async () => {
    ({ deleteReferences, refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));
    pullRequestNumber = await createPullRequest({
      base: refsDetails.master.ref,
      head: refsDetails.feature.ref,
      octokit,
      owner,
      repo,
    });
    await waitForKnownMergeableState({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });
    stopServer = startServer();
  }, 25000);

  afterAll(async () => {
    stopServer();

    await Promise.all([
      deleteReferences(),
      octokit.issues.deleteLabel({ name: label, owner, repo }),
    ]);
  });

  test("label removed and pull request commented", async () => {
    await Promise.all([
      waitForMockedHandlerCalls({
        handler: handleEvent,
        implementations: [
          async labeledEvent => {
            debug({ labeledEvent });
            expect(labeledEvent).toHaveProperty(
              ["payload", "pull_request", "mergeable_state"],
              "dirty",
            );
            // Tell Autorebase to attempt rebasing regardless of the mergeable state.
            return true;
          },
        ],
      }),
      waitForMockedHandlerCalls({
        handler: handleAction,
        implementations: [
          async failedAction => {
            debug({ failedAction });
            expect(failedAction.error.message).toMatch(/rebase failed/);
          },
        ],
      }),
      octokit.issues.addLabels({
        labels: [label],
        number: pullRequestNumber,
        owner,
        repo,
      }),
    ]);

    const labelsAfter = await getLabelNames(pullRequestNumber);
    expect(labelsAfter).not.toContain(label);

    const comment = await getLastIssueComment(pullRequestNumber);
    expect(comment).toMatch(/The rebase failed/);
  }, 35000);
});
