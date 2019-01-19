import * as Octokit from "@octokit/rest";
import * as createDebug from "debug";
import {
  PullRequestNumber,
  RepoName,
  RepoOwner,
} from "shared-github-internals/lib/git";
import {
  createPullRequest,
  createRefs,
  DeleteRefs,
  RefsDetails,
} from "shared-github-internals/lib/tests/git";
import * as generateUuid from "uuid/v4";

import { createApplicationFunction } from "./app";
import { Action } from "./autorebase";
import {
  createCheckOrStatus,
  createTestContext,
  debuggableStep,
  DeleteProtectedBranch,
  getLabelNames,
  getLastIssueComment,
  protectBranch,
  sleepAndWaitForKnownMergeableState,
  StartServer,
  StopServer,
  waitForMockedHandlerCalls,
} from "./tests-utils";
import { LabelName } from "./utils";

const debug = createDebug("autorebase:test");

const [initial, master1st, feature1st] = [
  "initial",
  "master 1st",
  "feature1st",
];

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

  let pullRequestANumber: PullRequestNumber;
  let pullRequestBNumber: PullRequestNumber;
  let refsDetails: RefsDetails;
  let deleteMasterBranch: DeleteProtectedBranch;
  let stopServer: StopServer;

  beforeAll(async () => {
    ({ refsDetails } = await createRefs({
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

    [pullRequestANumber, pullRequestBNumber] = await Promise.all(
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
        await sleepAndWaitForKnownMergeableState({
          debug,
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
    await debuggableStep("feature A clean but autosquashing needed", {
      async action() {
        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleAction,
            implementations: [
              async aAutosquashedAction => {
                debug({ aAutosquashedAction });
                expect(aAutosquashedAction).toEqual({
                  pullRequestNumber: pullRequestANumber,
                  type: "rebase",
                });
              },
            ],
          }),
          octokit.issues.addLabels({
            labels: [label],
            number: pullRequestANumber,
            owner,
            repo,
          }),
        ]);
      },
      debug,
    });

    await sleepAndWaitForKnownMergeableState({
      debug,
      octokit,
      owner,
      pullRequestNumber: pullRequestANumber,
      repo,
    });

    await debuggableStep(
      "feature B rebased because of error status on feature A",
      {
        async action() {
          await Promise.all([
            waitForMockedHandlerCalls({
              handler: handleEvent,
              implementations: [
                async bLabeledEvent => {
                  debug({ bLabeledEvent });
                  expect(bLabeledEvent).toHaveProperty(
                    ["payload", "pull_request", "number"],
                    pullRequestBNumber,
                  );
                  expect(bLabeledEvent).toHaveProperty(
                    ["payload", "action"],
                    "labeled",
                  );
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
                            pullRequestNumber: pullRequestBNumber,
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
              number: pullRequestBNumber,
              owner,
              repo,
            }),
          ]);
        },
        debug,
      },
    );

    await sleepAndWaitForKnownMergeableState({
      debug,
      octokit,
      owner,
      pullRequestNumber: pullRequestBNumber,
      repo,
    });

    await debuggableStep(
      "feature A merged after successful status, then feature B rebased",
      {
        async action() {
          await Promise.all([
            waitForMockedHandlerCalls({
              handler: handleAction,
              implementations: [
                async aMergedAction => {
                  debug({ aMergedAction });
                  expect(aMergedAction).toEqual({
                    pullRequestNumber: pullRequestANumber,
                    type: "merge",
                  });
                },
                async bRebasedAction => {
                  debug({ bRebasedAction });
                  expect(bRebasedAction).toEqual({
                    pullRequestNumber: pullRequestBNumber,
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
        debug,
      },
    );

    await sleepAndWaitForKnownMergeableState({
      debug,
      octokit,
      owner,
      pullRequestNumber: pullRequestBNumber,
      repo,
    });

    await debuggableStep(
      "feature B merged after review approval (with successful status)",
      {
        async action() {
          await Promise.all([
            waitForMockedHandlerCalls({
              handler: handleEvent,
              implementations: [
                async bSuccessfulCheckOrStatusEvent => {
                  debug({ bSuccessfulCheckOrStatusEvent });
                  expect(bSuccessfulCheckOrStatusEvent).toHaveProperty(
                    "name",
                    mode === "check" ? "check_run" : "status",
                  );
                  // Pretend that the pull request has actually been approved by a reviewer.
                  // That's because that's the event type we want to test here and not the status one.
                  // after an approved review status event.
                  bSuccessfulCheckOrStatusEvent.name = "pull_request_review";
                  bSuccessfulCheckOrStatusEvent.payload = {
                    action: "submitted",
                    pull_request: {
                      closed_at: null,
                      mergeable_state: "unknown",
                      number: pullRequestBNumber,
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
                    pullRequestNumber: pullRequestBNumber,
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
        debug,
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
    ({ refsDetails } = await createRefs({
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

    await sleepAndWaitForKnownMergeableState({
      debug,
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
    await debuggableStep("rebase conflict", {
      async action() {
        const actions: Action[] = [];
        const forceRebase = true;
        let unblockFirstCall: () => void;

        await Promise.all([
          waitForMockedHandlerCalls({
            handler: handleEvent,
            implementations: [
              async labeledEvent => {
                debug({ labeledEvent });
                expect(labeledEvent).toHaveProperty(
                  ["payload", "pull_request", "number"],
                  pullRequestNumber,
                );
                expect(labeledEvent).toHaveProperty(
                  ["payload", "action"],
                  "labeled",
                );
                await Promise.all([
                  new Promise(innerResolve => {
                    unblockFirstCall = innerResolve;
                  }).then(() => {
                    debug("first call unblocked");
                  }),
                  octokit.issues.removeLabel({
                    name: label,
                    number: pullRequestNumber,
                    owner,
                    repo,
                  }),
                ]);
                return forceRebase;
              },
              async unlabeledEvent => {
                debug({ unlabeledEvent });
                expect(unlabeledEvent).toHaveProperty(
                  ["payload", "pull_request", "number"],
                  pullRequestNumber,
                );
                expect(unlabeledEvent).toHaveProperty(
                  ["payload", "action"],
                  "unlabeled",
                );
                await octokit.issues.addLabels({
                  labels: [label],
                  number: pullRequestNumber,
                  owner,
                  repo,
                });
              },
              async relabeledEvent => {
                debug({ relabeledEvent });
                expect(relabeledEvent).toHaveProperty(
                  ["payload", "pull_request", "number"],
                  pullRequestNumber,
                );
                expect(relabeledEvent).toHaveProperty(
                  ["payload", "action"],
                  "labeled",
                );
                // Wait for a request to be made to GitHub before resolving the other call.
                // We need to do that because removing a label on a pull request is not a perfectly atomic lock.
                // Indeed, if two removal requests are made really close to one another (typically less than 10ms), GitHub will accept both of them.
                octokit.pulls
                  .get({
                    number: pullRequestNumber,
                    owner,
                    repo,
                  })
                  .then(unblockFirstCall);
                return forceRebase;
              },
            ],
          }),
          waitForMockedHandlerCalls({
            handler: handleAction,
            implementations: [
              async firstAction => {
                debug({ firstAction });
                actions.push(firstAction);
              },
              async secondAction => {
                debug({ secondAction });
                actions.push(secondAction);
                expect(actions).toContainEqual({
                  pullRequestNumber,
                  type: "abort",
                });
                expect(actions).toContainEqual({
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
      },
      debug,
    });

    await sleepAndWaitForKnownMergeableState({
      debug,
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });

    await debuggableStep("merge", {
      async action() {
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
      },
      debug,
    });
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

  let deleteRefs: DeleteRefs;
  let pullRequestNumber: PullRequestNumber;
  let refsDetails: RefsDetails;
  let stopServer: StopServer;

  beforeAll(async () => {
    ({ deleteRefs, refsDetails } = await createRefs({
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
    await sleepAndWaitForKnownMergeableState({
      debug,
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
      deleteRefs(),
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
              ["payload", "pull_request", "number"],
              pullRequestNumber,
            );
            expect(labeledEvent).toHaveProperty(
              ["payload", "action"],
              "labeled",
            );
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

    const labelsAfter = await getLabelNames({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });
    expect(labelsAfter).not.toContain(label);

    const comment = await getLastIssueComment({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });
    expect(comment).toMatch(/The rebase failed/);
  }, 35000);
});
