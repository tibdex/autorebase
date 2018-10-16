[![build status](https://img.shields.io/circleci/project/github/tibdex/autorebase.svg)](https://circleci.com/gh/tibdex/autorebase)

<h1 align="center">
  <img src="assets/logo.svg" height="250" width="250" alt="Autorebase logo"/>
  <p>Autorebase</p>
</h1>

Autorebase aims to make the Rebase Workflow enjoyable and keep `master` always green. [Try it!](https://github.com/apps/autorebase)

Autorebase is a GitHub App, based on [Probot](https://probot.github.io/), that automatically [rebase and merge](https://help.github.com/articles/about-merge-methods-on-github/#rebasing-and-merging-your-commits) pull requests.

It integrates especially well in repositories with branch protection set up to enforce up-to-date status checks.

# Usage

1.  :electric_plug: Install the publicly hosted [Autorebase GitHub App](https://github.com/apps/autorebase) on your repository.
2.  :closed_lock_with_key: [recommended] Protect the branches on which pull requests will be made, such as `master`. In particular, it's best to [enable required status checks](https://help.github.com/articles/enabling-required-status-checks/) with the "Require branches to be up to date before merging" option.
3.  :label: When you're ready to hand over a pull request to Autorebase, simply [add the `autorebase` label to it](https://help.github.com/articles/creating-a-label/).
4.  :sparkles: That's it! Pull requests with the `autorebase` label will then be rebased when their base branch moved forward ([`mergeable_state === "behind"`](https://developer.github.com/v4/enum/mergestatestatus/#behind)) and "rebased and merged" once all the branch protections are respected ([`mergeable_state === "clean"`](https://developer.github.com/v4/enum/mergestatestatus/#clean)).

# FAQ

## How Does It Work?

Autorebase relies on [`github-rebase`](https://www.npmjs.com/package/github-rebase) to perform all the required Git operations directly through the GitHub REST API instead of having to clone repositories on a server and executing Git CLI commands.

`github-rebase` is the :old_key: to being able to run Autorebase as a stateless, easy to maintain, and cheap to operate, GitHub App!

## Which Permissions & Webhooks Is Autorebase Using?

### Permissions

- **Repository contents** _[read & write]_: because the rebasing process requires creating commits and manipulating branches.
- **Issues** _[read & write]_: to search for pull requests to rebase or merge and add to manipulate labels on pull requests.
- **Pull requests** _[read & write]_: to merge pull requests.
- **Commit statuses** _[read-only]_: to know whether the status checks are green or not.

### Webhooks

- **Pull request**: to detect when the `autorebase` label is added/removed and when a pull request is closed.
  Indeed, closing a pull request by merging its changes on its base branch may require rebasing other pull requests based on the same branch since they would now be outdated.

  _Note:_ Instead of listening to the [`pull_request.closed`](https://developer.github.com/v3/activity/events/types/#pullrequestevent) webhook, Autorebase could listen to [`push`](https://developer.github.com/v3/activity/events/types/#pushevent) instead.
  It would allow it to react when a commit was pushed to `master` without going through a pull request.
  However, Autorebase would then receive much more events, especially since the rebasing process itself triggers many `push` events.
  Thus, to prevent pull requests with the `autorebase` label to get stuck behind their base branch, try not to push commits to these base branches without going through pull requests.

- **Pull request review**: because it can change the mergeable state of pull requests.
- **Status**: to know when the status checks turn green.

## Why Recommend Up-to-Date Status Checks?

To "keep `master` always green".

The goal is to never merge a pull request that could threaten the stability of the base branch test suite.

Green status checks are not enough to offer this guarantee. They must be [up-to-date](https://help.github.com/articles/types-of-required-status-checks/) to ensure that the pull request was tested against the latest code on the base branch. Otherwise, you're exposed to ["semantic conflicts"](https://bors.tech/essay/2017/02/02/pitch/).

## Why Rebasing Instead of Squashing/Merging?

### Squashing

Good pull requests are made of multiple small and atomic commits. You loose some useful information when squashing them in a single big commit. Decreasing the granularity of commits on `master` also makes tools such as [`git blame`](https://git-scm.com/docs/git-blame) and [`git bisect`](https://git-scm.com/docs/git-bisect) less powerful.

### Merging

Merge commits are often seen as undesirable clutter:

- They make the Git graph much more complex and arguably harder to use.
- They are often poorly named, such as "Merge #1337 into master", repeating what's already obvious.

Besides, even when pull requests are "rebased and merged" (actually merged with the [`--ff-only`](https://git-scm.com/docs/git-merge#git-merge---ff-only) option), you can still, when looking at a commit on `master` in the GitHub UI, find out which pull request introduced it.

### Enforcing Rebase Merging

If you're convinced that rebasing is the best option, you can easily [enforce it as the only allowed method to merge pull requests on your repository](https://help.github.com/articles/configuring-commit-rebasing-for-pull-requests/).

### Autosquashing

Autorebase has built-in [autosquashing](https://git-scm.com/docs/git-rebase#git-rebase---autosquash) support. It will come in handy to automatically fixup/squash these commits added on pull requests after a reviewer requested changes.

## Why Not Clicking on the “Update Branch” Button Provided by GitHub Instead?

Because it creates merge commits and thus exacerbates the issue explained just above.

## When Not to Use Autorebase?

Rebasing rewrites the Git history so it's best not to do it on pull requests where several developers are collaborating and pushing commits to the head branch.

## How Does Autorebase Compares with the Alternatives?

| Name                                                                               | No Merge Commits   | Stateless (no Database Required) | Ensure Up-to-Date Status Checks Without Manual Intervention / Test on Latest Before Merging | Comments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Bors](https://github.com/apps/bors)                                               | :x:                | :x:                              | :white_check_mark:                                                                          | Bors provides a more sophisticated rebasing strategy. It tries to batch pull requests together and see if the build is still passing on the "agglomerated pull request" before merging the corresponding pull requests. Bors might be better for projects with long/expensive CI builds and a high rate of incoming pull requests, since the time to run the builds is, in the best case, logarithmic with the number of pull requests.                                                                                                                                                                                                                                  |
| [automerge](https://github.com/apps/automerge)                                     | :x:                | :white_check_mark:               | :x:                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [Refined GitHub browser extension](https://github.com/sindresorhus/refined-github) | :x:                | :white_check_mark:               | :x:                                                                                         | Refined GitHub has an [option to wait for checks when merging a pull request](https://github.com/sindresorhus/refined-github#highlights) if you don't mind having to keep your browser tab opened waiting for the status checks to be green before merging your pull requests.                                                                                                                                                                                                                                                                                                                                                                                           |
| [TravisCI](https://travis-ci.com/)                                                 | :white_check_mark: | :white_check_mark:               | :x:                                                                                         | TravisCI goes halfway in the good direction: ["Rather than build the commits that have been pushed to the branch the pull request is from, we build the merge between the source branch and the upstream branch."](https://docs.travis-ci.com/user/pull-requests/#How-Pull-Requests-are-Built) but [they don't trigger a new build when the upstream/base branch move forward](https://github.com/travis-ci/travis-ci/issues/1620) so you still need to rebase your pull requests manually. Besides, it ties you to a specific CI provider since CircleCI, for instance, doesn't do the same "building the pull request from the merge commit provided by GitHub" trick. |
| Autorebase                                                                         | :white_check_mark: | :white_check_mark:               | :white_check_mark:                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Why the :panda_face: Logo?

Because Autorebase loves eating branches :bamboo:!
