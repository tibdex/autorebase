[![npm version](https://img.shields.io/npm/v/github-cherry-pick.svg)](https://npmjs.org/package/github-cherry-pick)
[![build status](https://img.shields.io/circleci/project/github/tibdex/autorebase.svg)](https://circleci.com/gh/tibdex/autorebase)

# Goal

`github-cherry-pick` cherry-picks several commits on a branch using [the low level Git Data operations provided by the GitHub REST API](https://developer.github.com/v3/git/).

See also [`github-rebase`](https://www.npmjs.com/package/github-rebase) if you want to rebase a pull request on its base branch.

# Usage

```javascript
const githubCherryPick = require("github-cherry-pick");

githubCherryPick({
  // The SHA list of the commits to cherry-pick.
  // The commits will be cherry-picked in the order they appear in the array.
  // See https://git-scm.com/docs/git-cherry-pick for more details.
  commits: [
    "8b10a7808f06970232dc1b45a77b47d63641c4f1",
    "f393441512c54435819d1cdd8921c0d566911af3",
  ],
  // The name of the branch/reference on top of which the commits will be cherry-picked.
  head: "awesome-feature",
  // An already authenticated instance of https://www.npmjs.com/package/@octokit/rest.
  // Its version should preferably be the same than the one in github-cherry-pick's package.json.
  octokit,
  // The login of the repository owner.
  owner,
  // The name of the repository.
  repo,
}).then(newHeadSha => {
  // Do something.
});
```

`github-cherry-pick` can run on Node.js and in recent browsers.

## Troubleshooting

`github-cherry-pick` uses [`debug`](https://www.npmjs.com/package/debug) to log helpful information at different steps of the cherry-picking process. To enable these logs, set the `DEBUG` environment variable to `github-cherry-pick`.

# How it works

The GitHub REST API doesn't provide a direct endpoint for cherry-picking commits on a branch but it does provide lower level Git operations such as:

- merging one branch on top of another one
- creating a commit from a Git tree
- creating/updating/deleting references

It turns out that's all we need to perform a cherry-pick!

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
git checkout master
git add C.txt
git commit --message C
git add D.txt
git commit --message D
git checkout feature
-->

```
* 1d3fb48 (HEAD -> feature) B
| * d706821 (master) D
| * 64046c3 C
|/
* 8291506 A
```

and we want to cherry-pick `7ab6282` and `cce4008` on the `feature` branch.

`github-cherry-pick` would then take the following steps:

1.  Create a `temp` branch from `feature` with [POST /repos/:owner/:repo/git/refs](https://developer.github.com/v3/git/refs/#create-a-reference).
    <!--
    git checkout -b temp
    -->
    ```
    * 1d3fb48 (HEAD -> temp, feature) B
    | * d706821 (master) D
    | * 64046c3 C
    |/
    * 8291506 A
    ```
2.  Merge `64046c3` on `temp` with [POST /repos/:owner/:repo/merges](https://developer.github.com/v3/repos/merging/#perform-a-merge).
    <!--
    git merge 64046c3
    -->
    ```
    *   6cb4aca (HEAD -> temp) Merge commit '64046c3' into temp
    |\
    * | 1d3fb48 (feature) B
    | | * d706821 (master) D
    | |/
    | * 64046c3 C
    |/
    * 8291506 A
    ```
3.  Create another commit from `6cb4aca` with `1d3fb48` as the only parent with [POST /repos/:owner/:repo/git/commits](https://developer.github.com/v3/git/commits/#create-a-commit) and update `temp`'s reference to point to this new commit with [PATCH /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#update-a-reference).
    <!--
    git cat-file -p 6cb4aca
    git commit-tree db5a9e1 -p 1d3fb48 -m C
    git update-ref HEAD 5b0786f
    -->
    ```
    * 5b0786f (HEAD -> temp) C
    * 1d3fb48 (feature) B
    | * d706821 (master) D
    | * 64046c3 C
    |/
    * 8291506 A
    ```
4.  Repeat steps 2. and 3. to cherry-pick `d706821` on `temp`.
    ```
    * ce81b2b (HEAD -> temp) D
    * 5b0786f C
    * 1d3fb48 (feature) B
    | * d706821 (master) D
    | * 64046c3 C
    |/
    * 8291506 A
    ```
5.  Set `feature`'s reference to the same one than `temp` with [PATCH /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#update-a-reference), making sure it's a fast-forward update.
    <!--
    git checkout feature
    git merge temp --ff-only
    -->
    ```
    * ce81b2b (HEAD -> feature, temp) D
    * 5b0786f C
    * 1d3fb48 B
    | * d706821 (master) D
    | * 64046c3 C
    |/
    * 8291506 A
    ```
6.  Delete the `temp` branch with [DELETE /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#delete-a-reference) and we're done!
    <!--
    git branch --delete temp
    -->
    ```
    * ce81b2b (HEAD -> feature) D
    * 5b0786f C
    * 1d3fb48 B
    | * d706821 (master) D
    | * 64046c3 C
    |/
    * 8291506 A
    ```

## Atomicity

`github-cherry-pick` is atomic.
It will either successfully cherry-pick all the given commits on the specified branch or let the branch untouched if one commit could not be cherry picked or if the branch reference changed while the cherry-picking was happening.
There are [tests](tests/index.test.js) for it.
