[![npm version](https://img.shields.io/npm/v/github-rebase.svg)](https://npmjs.org/package/github-rebase)
[![build status](https://img.shields.io/circleci/project/github/tibdex/autorebase.svg)](https://circleci.com/gh/tibdex/autorebase)

# Goal

`github-rebase` rebases a pull request using the GitHub REST API. It doesn't "merge"/close the pull request, it only rebases its head branch on top of its base branch.

See also [autorebase](https://github.com/settings/apps/autorebase) if you want to automatically rebase and then "merge" green and up-to-date pull requests.

# Usage

```javascript
const githubRebase = require("github-rebase");

githubRebase({
  // The number of the pull request to rebase.
  number: 1337,
  // An already authenticated instance of https://www.npmjs.com/package/@octokit/rest.
  // Its version should preferably be the same than the one in github-rebase's package.json.
  octokit,
  // The login of the repository owner.
  owner,
  // The name of the repository.
  repo,
}).then(newHeadSha => {
  // Do something.
});
```

## Troubleshooting

`github-rebase` uses [`debug`](https://www.npmjs.com/package/debug) to log helpful information at different steps of the cherry-picking process. To enable these logs, set the `DEBUG` environment variable to `github-rebase`.

# How it works

The GitHub REST API doesn't provide a direct endpoint to rebase a pull request without "merging"/closing it.
However, a rebase can be seen as a cherry-pick where the head and base branches would be reversed.
`github-rebase` thus relies on [`github-cherry-pick`](https://www.npmjs.com/package/github-cherry-pick) to handle the relevant cherry-pick operations needed to perform a rebase.

## Step by step

Let's say we have this Git state:

<!--
touch A.txt B.txt C.txt D.txt
git init
git add A.txt
git commit --message A
git checkout -b feature
git add B.txt
git commit --message B
git add C.txt
git commit --message C
git checkout master
git add D.txt
git commit --message D
-->

```
* 017bffc (feature) C
* 5b5b6e2 B
| * 3c70b13 (HEAD -> master) D
|/
* a5c5755 A
```

and a pull request where `master` is the base branch and `feature` the head branch. GitHub would say it as: "The user wants to merge 2 commits into `master` from `feature`".

To rebase the pull request, `github-rebase` would then take the following steps:

1.  Create a `temp` branch from `master` with [POST /repos/:owner/:repo/git/refs](https://developer.github.com/v3/git/refs/#create-a-reference).
    <!--
    git checkout -b temp
    -->
    ```
    * 017bffc (feature) C
    * 5b5b6e2 B
    | * 3c70b13 (HEAD -> temp, master) D
    |/
    * a5c5755 A
    ```
2.  Cherry-pick `5b5b6e2` and `017bffc` on top of `temp` with [`github-cherry-pick`](https://www.npmjs.com/package/github-cherry-pick).
    <!--
    git cherry-pick 5b5b6e2 017bffc
    -->
    ````
    * 6de5ac0 (HEAD -> temp) C
    * 544d948 B
    * 3c70b13 (master) D
    | * 017bffc (feature) C
    | * 5b5b6e2 B
    |/
    * a5c5755 A
    ```
    ````
3.  Check that `feature`'s reference is still `017bffc` with [GET /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#get-a-reference) or jump to step 5.
4.  Set `feature`'s reference to the same one than `temp` with [PATCH /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#update-a-reference).
    <!-- no corresponding Git CLI operation -->
    ```
    * 6de5ac0 (HEAD -> feature, temp) C
    * 544d948 B
    * 3c70b13 (master) D
    * a5c5755 A
    ```
5.  Delete the `temp` branch with [DELETE /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#delete-a-reference) and we're done!
      <!--
      git branch --delete temp
      -->
    ```
    * 6de5ac0 (HEAD -> feature) C
    * 544d948 B
    * 3c70b13 (master) D
    * a5c5755 A
    ```

## Atomicity

`github-rebases` tries as hard as possible to be atomic.

- The underlying cherry-pick operations are atomic.
- The only thing that can go wrong is when a commit is pushed on the pull request head branch between the steps 3. and 4. explained above.
  In that case, the commit that was just pushed won't be part of the pull request head branch anymore.
  It doesn't mean that this particular commit is completely lost.
  Commits are immutable and, once pushed, they can always be retrieved from their SHA.
  There is no way to fix this issue as the GitHub REST API doesn't provide a compare-and-swap endpoint for updating references like it does for merges.
  Hopefully the issue should almost never occurs since the window during which the head branch is vulnerable usually lasts less than 100 milliseconds (the average GitHub REST API response time).

There are [tests](tests/index.test.js) for it.
