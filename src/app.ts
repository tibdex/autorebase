import * as Octokit from "@octokit/rest";
import { Application } from "probot";

import { Action, autorebase, CanRebaseOneTime, Event } from "./autorebase";
import { LabelName } from "./utils";

type ActionHandler = (action: Action) => Promise<void>;

type EventHandler = (event: Event) => Promise<boolean | void>;

const requireWriteAccessForOneTimeRebase: CanRebaseOneTime = permission =>
  permission === "admin" || permission === "write";

type Options = {
  canRebaseOneTime: CanRebaseOneTime;
  handleAction: ActionHandler;
  handleEvent: EventHandler;
  /**
   * Pull requests without this label will be ignored.
   */
  label: LabelName;
};

const createApplicationFunction = (options: Options) => (app: Application) => {
  app.log("App loaded");

  app.on(
    [
      "check_run.completed",
      "issue_comment.created",
      "pull_request",
      "pull_request_review.submitted",
      "status",
    ],
    async context => {
      const { owner, repo } = context.repo();

      const event: Event = {
        id: context.id,
        // @ts-ignore The event is of the good type because Autorebase only subscribes to a subset of webhooks.
        name: context.name,
        payload: context.payload,
      };
      const handlerResult = await options.handleEvent(event);
      const forceRebase = handlerResult === true;

      let action: Action = { type: "nop" };
      try {
        action = await autorebase({
          canRebaseOneTime: options.canRebaseOneTime,
          event,
          forceRebase,
          label: options.label,
          // The value is the good one even if the type doesn't match.
          octokit: (context.github as any) as Octokit,
          owner,
          repo,
        });
      } catch (error) {
        action = { error, type: "failed" };
        throw error;
      } finally {
        context.log(action);
        if (action.type !== "nop") {
          await options.handleAction(action);
        }
      }
    },
  );
};

export { createApplicationFunction, requireWriteAccessForOneTimeRebase };
