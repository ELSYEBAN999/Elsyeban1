/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { expect, jest, test } from "@jest/globals";
import { CIHelper } from "../lib/ci-helper";
import { gitConfig } from "../lib/git";
import { GitNotes } from "../lib/git-notes";
import {
     GitHubGlue, IGitHubUser, IPRComment, IPRCommit, IPullRequestInfo,
} from "../lib/github-glue";
import { IMailMetadata } from "../lib/mail-metadata";
import { testCreateRepo, TestRepo } from "./test-lib";

jest.setTimeout(180000);

// smtp testing support.  NodeMailer suggests using ethereal.email.
// The config must be set for the submit/preview tests to work.  They
// are skipped if the config is not set.
//
// Sample config settings:
// [gitgitgadget]
//  CIsmtpUser = first.last@ethereal.email
//  CIsmtphost = smtp.ethereal.email
//  CIsmtppass = feedeadbeeffeeddeadbeef
//  CIsmtpopts = {port: 587, secure: false, tls: {rejectUnauthorized: false}}

async function getSMTPInfo():
    Promise <{ smtpUser: string; smtpHost: string;
               smtpPass: string; smtpOpts: string; }> {
    const smtpUser = await gitConfig("gitgitgadget.CIsmtpUser") || "";
    const smtpHost = await gitConfig("gitgitgadget.CIsmtpHost") || "";
    const smtpPass = await gitConfig("gitgitgadget.CIsmtpPass") || "";
    const smtpOpts = await gitConfig("gitgitgadget.CIsmtpOpts") || "";
    return { smtpUser, smtpHost, smtpPass, smtpOpts };
}

// Mocking class to replace GithubGlue with mock of GitHubGlue

class TestCIHelper extends CIHelper {
    public ghGlue: GitHubGlue;      // not readonly reference
    public addPRComment: any;
    public updatePR: any;

    public constructor(workDir?: string, debug = false, gggDir = ".") {
        super(workDir, debug, gggDir);
        this.testing = true;
        this.ghGlue = this.github;
        this.addPRComment = jest.fn();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.ghGlue.addPRComment = this.addPRComment;
        this.updatePR = jest.fn();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.ghGlue.updatePR = this.updatePR;
        // need keys to authenticate
        // this.ghGlue.ensureAuthenticated = async (): Promise<void> => {};
    }

    public setGHgetPRInfo(o: IPullRequestInfo): void {
        this.ghGlue.getPRInfo = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPullRequestInfo> => o );
    }

    public setGHgetPRComment(o: IPRComment): void {
        this.ghGlue.getPRComment = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPRComment> => o );
    }

    public setGHgetPRCommits(o: IPRCommit[]): void {
        this.ghGlue.getPRCommits = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPRCommit[]> => o );
    }

    public setGHgetGitHubUserInfo(o: IGitHubUser): void {
        this.ghGlue.getGitHubUserInfo = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IGitHubUser> => o );
    }
}

// Create three repos.
// worktree is a local copy for doing updates and has the config
// info that would normally be in the gitgitgadget repo.  To ensure
// testing isolation, worktree is NOT the repo used for git clone
// tests.  That work is done in gggLocal.

// gggRemote represents the master on github.

// gggLocal represents the empty repo to be used by gitgitgadget.  It
// is empty to ensure nothing needs to be present (worktree would
// have objects present).

async function setupRepos(instance: string):
    Promise <{ worktree: TestRepo; gggLocal: TestRepo; gggRemote: TestRepo }> {
    const worktree = await testCreateRepo(__filename, `-work-cmt${instance}`);
    const gggLocal = await testCreateRepo(__filename, `-git-lcl${instance}`);
    const gggRemote = await testCreateRepo(__filename, `-git-rmt${instance}`);

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    await gggLocal.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // set needed config
    await worktree.git([
        "config", "--add", "gitgitgadget.workDir", gggLocal.workDir,
    ]);
    await worktree.git([
        "config", "--add", "gitgitgadget.publishRemote",
        "https://github.com/gitgitgadget/git",
    ]);

    const { smtpUser, smtpHost, smtpPass, smtpOpts } =
        await getSMTPInfo();

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpUser",
        smtpUser ? smtpUser : "test",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpHost",
        smtpHost ? smtpHost : "test",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpPass",
        smtpPass ? smtpPass : "test",
    ]);

    if (smtpOpts) {
        await worktree.git([
            "config", "--add", "gitgitgadget.smtpOpts", smtpOpts,
        ]);
    }

    const notes = new GitNotes(gggRemote.workDir);
    await notes.set("", {allowedUsers: ["ggg", "user1"]}, true);

    // Initial empty commit
    const commitA = await gggRemote.commit("A");
    expect(commitA).not.toBeUndefined();

    // Set up fake upstream branches
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "seen"]);

    return { worktree, gggLocal, gggRemote };
}

test("identify merge that integrated some commit", async () => {
    const repo = await testCreateRepo(__filename);

    /*
     * Create a branch structure like this:
     *
     * a - b ----- c - d
     *   \       /   /
     *   | e ----- f
     *   \       /
     *     g - h
     */
    const a = await repo.commit("a");
    const g = await repo.commit("g");
    const h = await repo.commit("h");
    await repo.git(["reset", "--hard", a]);
    const e = await repo.commit("e");
    const f = await repo.merge("f", h);
    await repo.git(["reset", "--hard", a]);
    const b = await repo.commit("b");
    const c = await repo.merge("c", e);
    const d = await repo.merge("d", f);
    await repo.git(["update-ref", "refs/remotes/upstream/seen", d]);

    const ci = new CIHelper(repo.workDir);
    expect(b).not.toBeUndefined();
    expect(await ci.identifyMergeCommit("seen", g)).toEqual(d);
    expect(await ci.identifyMergeCommit("seen", e)).toEqual(c);
    expect(await ci.identifyMergeCommit("seen", h)).toEqual(d);
});

test("identify upstream commit", async () => {
    // initialize test worktree and gitgitgadget remote
    const worktree = await testCreateRepo(__filename, "-worktree");
    const gggRemote = await testCreateRepo(__filename, "-gitgitgadget");

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // Set up fake upstream branches
    const commitA = await gggRemote.commit("A");
    expect(commitA).not.toBeUndefined();
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "seen"]);

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const b = await worktree.commit("b");

    // "Contribute" it via a PullRequest
    const pullRequestURL = "https://example.com/pull/123";
    const messageID = "fake-1st-mail@example.com";
    const notes = new GitNotes(worktree.workDir);
    await notes.appendCommitNote(b, messageID);
    const bMeta = {
        messageID,
        originalCommit: b,
        pullRequestURL,
    } as IMailMetadata;
    await notes.set(messageID, bMeta);

    // "Apply" the patch, and merge it
    await gggRemote.newBranch("gg/via-pull-request");
    const commitB = await gggRemote.commit("B");
    await gggRemote.git(["checkout", "seen"]);
    await gggRemote.git(["merge", "--no-ff", "gg/via-pull-request"]);

    // Update the `mail-to-commit` notes ref, at least the part we care about
    const mail2CommitNotes = new GitNotes(gggRemote.workDir,
                                          "refs/notes/mail-to-commit");
    await mail2CommitNotes.setString(messageID, commitB);

    // "publish" the gitgitgadget notes
    await worktree.git(["push", gggRemote.workDir, notes.notesRef]);

    const ci = new TestCIHelper(worktree.workDir);
    expect(await ci.identifyUpstreamCommit(b)).toEqual(commitB);

    expect(await ci.updateCommitMapping(messageID)).toBeTruthy();
    const bMetaNew = await notes.get<IMailMetadata>(messageID);
    expect(bMetaNew).not.toBeUndefined();
    expect(bMetaNew?.originalCommit).toEqual(b);
    expect(bMetaNew?.commitInGitGit).toEqual(commitB);
});

test("handle comment allow basic test", async () => {
    const { worktree, gggLocal } = await setupRepos("a1");

    // Ready to start testing
    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",              // set in setupRepos
        body: "/allow  user2",
        prNumber,
    };
    const user = {
        email: "user2@example.com",
        login: "user2",
        name: "User Two",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is now allowed to use GitGitGadget/);
});

test("handle comment allow fail invalid user", async () => {
    const { worktree, gggLocal } = await setupRepos("a2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow  bad_@@@@",
        prNumber,
    };

    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is not a valid GitHub username/);
});

test("handle comment allow no public email", async () => {
    const { worktree, gggLocal } = await setupRepos("a3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow   bad",
        prNumber,
    };
    const user: IGitHubUser = {
        email: null,
        login: "noemail",
        name: "no email",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is now allowed to use GitGitGadget/);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/no public email address set/);
});

test("handle comment allow already allowed", async () => {
    const { worktree, gggLocal } = await setupRepos("a4");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow  ggg",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already allowed to use GitGitGadget/);
});

test("handle comment allow no name specified (with trailing white space)",
     async () => {
    const { worktree, gggLocal } = await setupRepos("a5");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already allowed to use GitGitGadget/);
});

test("handle comment disallow basic test", async () => {
    const { worktree, gggLocal } = await setupRepos("d1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  user1 ",
        prNumber,
    };
    const user = {
        email: "user1@example.com",
        login: "user1",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is no longer allowed to use GitGitGadget/);
});

test("handle comment disallow was not allowed", async () => {
    const { worktree, gggLocal } = await setupRepos("d2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  unknown1 ",
        prNumber,
    };

    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already not allowed to use GitGitGadget/);
});

test("handle comment submit not author", async () => {
    const { worktree, gggLocal } = await setupRepos("s1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggNOTg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // eslint-disable-next-line max-len
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Only the owner of a PR can submit/);
});

test("handle comment submit not mergable", async () => {
    const { worktree, gggLocal } = await setupRepos("s2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: false,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Do Not Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/does not merge cleanly/);
});

test("handle comment submit email success", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("s3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\r\nnew line";
    // add template to master repo
    await gggRemote.commit("temple", ".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BA55FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Submit ok\n\nSuccint message\n\nSigned-off-by: x",
        parentCount: 1,
    }];
    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: `Super body\r\n${template}\r\nCc: Copy One <copy@cat.com>\r\n`
            + "Cc: Copy Two <copycat@cat.com>",
        hasComments: true,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    const { smtpUser } = await getSMTPInfo();

    if (smtpUser) {                 // if configured for this test
        ci.setGHgetPRInfo(prinfo);
        ci.setGHgetPRComment(comment);
        ci.setGHgetPRCommits(commits);
        ci.setGHgetGitHubUserInfo(user);

        await ci.handleComment("gitgitgadget", 433865360);
        expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Submitted as/);
    }
});

test("handle comment preview email success", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("p1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\nnew line";
    await gggRemote.commit("temple", ".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "preview@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BA55FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Submit ok\n\nSigned-off-by: x",
        parentCount: 1,
    }];
    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "There will be a submit email and a preview email.",
        hasComments: true,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    const { smtpUser } = await getSMTPInfo();

    if (smtpUser) {                 // if configured for this test
        ci.setGHgetPRInfo(prinfo);
        ci.setGHgetPRComment(comment);
        ci.setGHgetPRCommits(commits);
        ci.setGHgetGitHubUserInfo(user);

        await ci.handleComment("gitgitgadget", 433865360);
        expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Submitted as/);

        comment.body = " /preview";
        ci.setGHgetPRComment(comment);
        await ci.handleComment("gitgitgadget", 433865360); // do it again
        // eslint-disable-next-line max-len
        expect(ci.addPRComment.mock.calls[1][1]).toMatch(/Preview email sent as/);

        await ci.handleComment("gitgitgadget", 433865360); // should still be v2
    }
});

test("handle push/comment too many commits fails", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("pu1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    const commits = 40;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "preview@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - too many commits.",
        commits,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    const failMsg = `The pull request has ${commits} commits.`;
    // fail for too many commits on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRComment.mock.calls[0][1]).toMatch(failMsg);
    ci.addPRComment.mock.calls.length = 0;

    // fail for too many commits on submit
    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(failMsg);
    ci.addPRComment.mock.calls.length = 0;

    // fail for too many commits on preview
    comment.body = " /preview";
    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(failMsg);
    ci.addPRComment.mock.calls.length = 0;

    // fail for too many commits push new user
    prinfo.author = "starfish";
    comment.author = "starfish";
    user.login = "starfish";
    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(failMsg);
});

test("handle push/comment merge commits fails", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD1FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 2,
    }];

    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetPRCommits(commits);
    ci.setGHgetGitHubUserInfo(user);

    // fail for merge commits on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRComment.mock.calls[0][1]).toMatch(commits[0].commit);
    ci.addPRComment.mock.calls.length = 0;

    // fail for merge commits on submit
    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(commits[0].commit);
    ci.addPRComment.mock.calls.length = 0;

    // fail for merge commits on preview
    comment.body = " /preview";
    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(commits[0].commit);
    ci.addPRComment.mock.calls.length = 0;

    // fail for merge commits push new user
    prinfo.author = "starfish";
    comment.author = "starfish";
    user.login = "starfish";

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(commits[0].commit);
    ci.addPRComment.mock.calls.length = 0;

    // Test Multiple merges
    commits.push({
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD2FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 1,
    });
    commits.push({
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD3FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 2,
    });

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(commits[0].commit);
    expect(ci.addPRComment.mock.calls[1][1]).not.toMatch(commits[1].commit);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(commits[2].commit);
    ci.addPRComment.mock.calls.length = 0;

});

test("disallow noreply emails", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "random@users.noreply.github.com",
            login: "random",
            name: "random",
        },
        commit: "BAD1FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Using ineligible email address",
        parentCount: 1,
    }];

    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetPRCommits(commits);
    ci.setGHgetGitHubUserInfo(user);

    // fail for commits with fake email on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

});

// Basic tests for ci-helper - lint tests are in commit-lint.tests.ts

test("basic lint tests", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu4");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD1FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Message has no description",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD2FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Missing blank line is bad\nhere\nSigned-off-by: x",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "F00DFEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Successful test\n\nSigned-off-by: x",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD5FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "tests: This should be lower case\n\nSigned-off-by: x",
            parentCount: 1,
        },
    ];

    const prinfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetPRCommits(commits);
    ci.setGHgetGitHubUserInfo(user);

    // fail for commits with lint errors
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(commits[0].commit);
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/too short/);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(commits[1].commit);
    expect(ci.addPRComment.mock.calls[1][1]).toMatch(/empty line/);
    expect(ci.addPRComment.mock.calls[2][1]).toMatch(commits[3].commit);
    expect(ci.addPRComment.mock.calls[2][1]).toMatch(/lower case/);

});

test("Handle comment cc", async () => {
    const {worktree, gggLocal} = await setupRepos("cc");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/cc \"Some Body\" <sbody@example.com>",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };

    const prinfo = {
        author: "ggg",
        baseCommit: "foo",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - no cc.",
        commits: 1,
        hasComments: false,
        headCommit: "bar",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePR.mock.calls[0][2]).toMatch(/Some Body/);
    ci.updatePR.mock.calls.length = 0;

    // eslint-disable-next-line max-len
    comment.body = "/cc \"A Body\" <abody@example.com>, \"S Body\" <sbody@example.com>";

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePR.mock.calls[0][2]).toMatch(/A Body/);
    expect(ci.updatePR.mock.calls[1][2]).toMatch(/S Body/);
    ci.updatePR.mock.calls.length = 0;

    // email will not be readded to list
    prinfo.body = "changes\n\ncc: <abody@example.com>";

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePR.mock.calls[0][2]).toMatch(/S Body/);
    expect(ci.updatePR.mock.calls.length).toEqual(1);

});
