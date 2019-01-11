import { Application } from "probot";

import { Action, autorebase, Event } from "./autorebase";
import { LabelName } from "./utils";

type ActionHandler = (action: Action) => Promise<void>;

type EventHandler = (event: Event) => Promise<void>;

type Options = {
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
      "pull_request",
      "pull_request_review.submitted",
      "status",
    ],
    async context => {
      const { owner, repo } = context.repo();

      // @ts-ignore The event is of the good type because Autorebase only subscribes to a subset of webhooks.
      const event: Event = { name: context.name, payload: context.payload };
      await options.handleEvent(event);

      let action;
      try {
        action = await autorebase({
          event,
          label: options.label,
          // @ts-ignore The value is the good one even if the type doesn't match.
          octokit: context.github,
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

export { createApplicationFunction };
