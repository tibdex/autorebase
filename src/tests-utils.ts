import * as Octokit from "@octokit/rest";
import * as envalid from "envalid";
import { Application, createProbot } from "probot";
import { createWebhookProxy } from "probot/lib/webhook-proxy";
import {
  deleteRef,
  fetchRefSha,
  PullRequestNumber,
  Ref,
  RepoName,
  RepoOwner,
} from "shared-github-internals/lib/git";

import { Debug, sleep, waitForKnownMergeableState } from "./utils";

// tslint:disable:no-var-requires
const App = require("@octokit/app");
const isBase64 = require("is-base64");
// tslint:enable:no-var-requires

type DeleteProtectedBranch = () => Promise<void>;

type StopServer = () => void;

type StartServer = () => StopServer;

type TestContext = {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  startServer: StartServer;
};

const nop = () => {
  // Do nothing.
};

const checkOrStatusName = "autorebase-test";

// We don't use the one from Probot because it is throttled so it would make the tests slow.
const createAuthenticatedOctokit = async ({
  appId,
  installationId,
  privateKey,
}: {
  appId: number;
  installationId: number;
  privateKey: string;
}) => {
  const app = new App({ id: appId, privateKey });
  const installationAccessToken = await app.getInstallationAccessToken({
    installationId,
  });
  const octokit = new Octokit({ auth: `token ${installationAccessToken}` });
  return octokit;
};

const createTestContext = async (
  applicationFunction: (app: Application) => void,
): Promise<TestContext> => {
  const env = envalid.cleanEnv(
    // eslint-disable-next-line no-process-env
    process.env,
    {
      TEST_APP_ID: envalid.num({
        desc:
          "The ID of the GitHub App used during tests." +
          " It must have at least the same permissions than the Autorebase GitHub App.",
      }),
      TEST_APP_PRIVATE_KEY: envalid.makeValidator(str => {
        const privateKeyFromEnv = isBase64(str)
          ? Buffer.from(str, "base64").toString("utf8")
          : str;
        if (
          /-----BEGIN RSA PRIVATE KEY-----[\s\S]+-----END RSA PRIVATE KEY-----/m.test(
            privateKeyFromEnv,
          )
        ) {
          return privateKeyFromEnv;
        }
        throw new Error("invalid GitHub App RSA private key");
      })({
        docs:
          "https://developer.github.com/apps/building-integrations/setting-up-and-registering-github-apps/registering-github-apps/#generating-a-private-key",
      }),
      TEST_INSTALLATION_ID: envalid.num({
        desc:
          'Can be found in the "Installed GitHub Apps" section of the developer settings',
      }),
      TEST_REPOSITORY_NAME: envalid.str({
        desc: "Name of the repository against which the tests will be run",
      }),
      TEST_REPOSITORY_OWNER: envalid.str({
        desc: "Owner of the repository against which the tests will be run.",
      }),
      TEST_SMEE_URL: envalid.url({
        desc: "The smee URL used as the webhook URL of the test APP.",
      }),
      TEST_WEBHOOK_SECRET: envalid.str({
        desc: "The webhook secret used by the test App.",
      }),
    },
    { strict: true },
  );

  const repo = env.TEST_REPOSITORY_NAME;
  const owner = env.TEST_REPOSITORY_OWNER;
  const privateKey = env.TEST_APP_PRIVATE_KEY as string;

  const probot = createProbot({
    cert: privateKey,
    id: env.TEST_APP_ID,
    secret: env.TEST_WEBHOOK_SECRET,
  });
  probot.load(applicationFunction);
  const octokit = await createAuthenticatedOctokit({
    appId: env.TEST_APP_ID,
    installationId: env.TEST_INSTALLATION_ID,
    privateKey,
  });

  const startServer: StartServer = () => {
    const server = probot.server.listen(0);
    const { port } = server.address() as { port: number };
    const smeeEvents = createWebhookProxy({
      logger: {
        error: nop,
        info: nop,
        warn: nop,
      },
      path: "/",
      port,
      url: env.TEST_SMEE_URL,
    });
    return () => {
      smeeEvents.close();
      server.close();
    };
  };

  return { octokit, owner, repo, startServer };
};

const createCheckOrStatus = async ({
  error,
  mode,
  octokit,
  owner,
  ref,
  repo,
}: {
  error?: boolean;
  mode: "check" | "status";
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
}) => {
  const sha = await fetchRefSha({
    octokit,
    owner,
    ref,
    repo,
  });
  if (mode === "check") {
    await octokit.checks.create({
      completed_at: new Date().toISOString(),
      conclusion: error === true ? "failure" : "success",
      head_sha: sha,
      name: checkOrStatusName,
      owner,
      repo,
      status: "completed",
    });
  } else {
    await octokit.repos.createStatus({
      context: checkOrStatusName,
      owner,
      repo,
      sha,
      state: error === true ? "error" : "success",
    });
  }

  return sha;
};

const protectBranch = async ({
  octokit,
  owner,
  ref: branch,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoOwner;
}): Promise<DeleteProtectedBranch> => {
  await octokit.repos.updateBranchProtection({
    branch,
    enforce_admins: true,
    owner,
    repo,
    required_pull_request_reviews: null,
    required_status_checks: { contexts: [checkOrStatusName], strict: true },
    restrictions: null,
  });
  return async () => {
    await octokit.repos.removeBranchProtection({
      branch,
      owner,
      repo,
    });
    await deleteRef({
      octokit,
      owner,
      ref: branch,
      repo,
    });
  };
};

type Handler<T> = (arg: T) => Promise<any>;

const waitForMockedHandlerCalls = <T>({
  handler,
  implementations,
}: {
  handler: Handler<T> & jest.Mock;
  implementations: Array<Handler<T>>;
}): Promise<void> => {
  const initialMock: jest.Mock = handler;
  return new Promise(resolve => {
    implementations.reduce(
      (mock, implementation, index) =>
        mock.mockImplementationOnce(async arg => {
          const result = await implementation(arg);
          if (index === implementations.length - 1) {
            resolve();
          }
          return result;
        }),
      initialMock,
    );
  });
};
const debuggableStep = async (
  name: string,
  {
    action,
    debug,
  }: {
    action: () => Promise<void>;
    debug: Debug;
  },
) => {
  debug(`[start] ${name}`);
  try {
    await action();
    debug(`[done] ${name}`);
  } catch (error) {
    debug(`[failed] ${name}`);
    throw error;
  }
};

const getLabelNames = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  const { data: labels } = await octokit.issues.listLabelsOnIssue({
    number: pullRequestNumber,
    owner,
    repo,
  });
  return labels.map(({ name }) => name);
};

const getLastIssueComment = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  const { data: comments } = await octokit.issues.listComments({
    number: pullRequestNumber,
    owner,
    repo,
  });
  expect(comments.length).toBeGreaterThanOrEqual(1);
  return comments[comments.length - 1].body;
};

const sleepAndWaitForKnownMergeableState = ({
  debug,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) =>
  Promise.all([
    sleep(2500),
    waitForKnownMergeableState({
      debug,
      octokit,
      owner,
      pullRequestNumber,
      repo,
    }),
  ]);

export {
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
};
