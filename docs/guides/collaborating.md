# Working with a collaborator

This guide is for an author. It explains what the History pane's **Shared copies** view
does, how to get a second person working on the same project, and what each refusal means
when a send or a get does not go through. The app opens this page from the notification
such a refusal leaves.

<!-- toc -->

- [What a shared copy is](#what-a-shared-copy-is)
- [Connecting one](#connecting-one)
- [Sending and getting saves](#sending-and-getting-saves)
- [When both of you changed one file](#when-both-of-you-changed-one-file)
- [Signing in: credential helpers](#signing-in-credential-helpers)
- [What a refusal means](#what-a-refusal-means)
- [Getting a collaborator started](#getting-a-collaborator-started)
- [Limits](#limits)

<!-- tocstop -->

## What a shared copy is

Every save the app makes is a git commit in the project's own repository, on your machine.
A _shared copy_ is a second copy of that repository somewhere both of you can reach: a
repository on GitHub or a similar service, a folder on a NAS, or a folder on a USB drive.
Git calls it a _remote_. Nothing in the project is sent anywhere until you press **Send my
saves**, and nothing arrives until you press **Get their saves**.

The app never creates the shared copy. On GitHub, make an empty repository first (no
README, no license, so the first send has nothing to collide with) and copy its address.
For a folder, an empty folder that git has been told is a bare repository will do:
`git init --bare D:\backup\rooftop.git`.

The first copy you connect becomes the one the project _syncs with_: **Get their saves**
reads from it, and the strip at the top of the History pane counts saves against it. You
can connect more copies — a backup on a drive, say — and send to each one separately.

## Connecting one

In the History pane, press **Shared copies**, then **Connect a shared copy…**. The form
asks for a name and an address:

- The name is what the app calls the copy. `origin` is the usual first name, and the form
  offers it; letters, digits, dots, dashes and underscores are allowed.
- The address is one of:
    - `https://github.com/you/rooftop.git` — an https address; signing in is covered
      below.
    - `git@github.com:you/rooftop.git` — an SSH address, which uses a key you have already
      set up with the service.
    - `D:\backup\rooftop.git` or `/Volumes/Backup/rooftop.git` — a folder on this machine
      or a mounted drive.

**Change address…** on a connected copy fixes a mistyped address or follows a copy that
moved. **Remove** forgets the copy's name and address; nothing in the project and nothing
in the copy itself is removed, and it can be connected again later.

## Sending and getting saves

Each copy's row in the view says how many saves it lacks (_to send_) and how many it has
that you do not (_to get_), with when the app last asked. **Check** asks the copy again
without changing anything here.

**Send my saves** sends every save the copy lacks, checkpoints included. **Get their
saves** fetches what a collaborator sent and puts your own unsent saves on top of theirs,
so the project's history stays one line rather than forking. Both can take a few seconds
over a network; the footer counts while they run, and every other write in the pane waits.

The app never forces a send. If the copy has saves you have not got yet, **Send my saves**
is refused until you get theirs first, and the reason says so.

## When both of you changed one file

Getting their saves replays your unsent saves one at a time on top of theirs. When one of
your saves and one of theirs both changed the same file, the replay stops and the History
pane's detail column becomes the conflict view: _Replaying 2 of 3: Moved line L4 into
rooftop_, then one row per file waiting on a decision.

- **Keep mine** keeps your version of that file; **Take theirs** takes your
  collaborator's.
- **Open both** shows the two versions side by side first, for a scene, a sheet or another
  text file git merged line by line. A layout, a graph or a picture has no middle to read,
  so it offers only the two sides.
- A scene git merged textually may hold both versions between `<<<<<<<` and `>>>>>>>`
  markers. Keep a side, or edit the markers out in the Script pane; **Continue** is
  refused while any scene still holds them.
- **Continue** finishes the save being replayed and goes on to the next, which may stop
  again. Edits you make while the conflict view is up become part of the save being
  replayed, which the view's footer says.
- **Give up** puts your saves back exactly as they were before you pressed **Get their
  saves**. Their saves stay at the shared copy for another try.

The app's own logs (the command record and the notification log under `vngen/state/`)
never wait on a decision: git combines both of your runs of lines, so a sync that stops
does so on something one of you wrote. The rule for that comes from the project's
`.gitattributes`, and the app keeps a copy of it inside the repository so it applies to a
save made before the rule was.

A save of yours that the replay finds already present on their side — because they had
taken it from you earlier — is dropped rather than duplicated. The History pane's
provenance follows a replayed save to its new identity, so **Open the conversation** and
the command record behind a save still work after a sync.

## Signing in: credential helpers

A send or a get over https has to sign in, and the app runs git without a terminal, so git
cannot ask you for a password. It has to find the sign-in through a _credential helper_,
which stores it once and answers every time after.

- **Windows.** Git for Windows installs Git Credential Manager and turns it on. The first
  send opens the manager's own window, you sign in there, and it remembers. If it was
  turned off: `git config --global credential.helper manager`.
- **macOS.** The git that comes with the Xcode command-line tools stores sign-ins in the
  Keychain once told to: `git config --global credential.helper osxkeychain`. The first
  send after that still has to learn the password, so run one send from Terminal
  (`git push` inside the project folder), answer the prompt, and the app's sends work from
  then on.
- **Linux.** `git config --global credential.helper libsecret` stores the sign-in in the
  desktop keyring, where the package that provides it is installed
  (`git-credential-libsecret`, sometimes built from `contrib/` by hand). Without a
  keyring, `git config --global credential.helper 'cache --timeout=86400'` keeps it in
  memory for a day. As on macOS, the first sign-in has to happen from a terminal.

GitHub does not accept an account password over https; the sign-in is a _personal access
token_ with the `repo` scope, or the browser sign-in Git Credential Manager offers. An SSH
address sidesteps all of this when a key is already registered with the service.

A send that fails for want of a sign-in is refused in git's own words, usually mentioning
`Authentication failed` or `could not read Username`, and the notification links here.

## What a refusal means

What the app says itself, before touching the network:

| It says                                                              | It means                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _No shared copy is set to sync with; connect one first._             | The branch has no copy to get from. Connect one, or press **Sync with this copy** on one already connected.                                                                                            |
| _There are edits on disk not yet saved; save or discard them first._ | Something changed files outside the app since the last save. **Save these…** in the status line saves them; then get theirs.                                                                           |
| _Getting their saves is unfinished; finish or give it up first._     | A previous get stopped on a collision. The conflict view is waiting.                                                                                                                                   |
| _“origin” has 2 saves you do not; get their saves first._            | Sending would fork the history. Get theirs, resolve anything that collides, then send.                                                                                                                 |
| _Nothing to send; “origin” has every save._                          | The copy is current.                                                                                                                                                                                   |
| _The story bible has 1 save not yet sent; send those first…_         | The wiki is its own repository nested in the project, and the project's history names its saves. Send the wiki's saves from its own entry in the strip first, so the copy never names a save it lacks. |
| _“origin” has no main yet; send your saves first._                   | The copy is empty. The first send creates the branch there.                                                                                                                                            |

A refusal in git's own words came from the copy or the network: a wrong address
(`Could not resolve host`, `repository not found`), a sign-in it did not get (above), or a
copy someone else sent to since the app last checked (`fetch first`, `non-fast-forward`),
which **Get their saves** resolves.

## Getting a collaborator started

The collaborator clones the shared copy and opens the folder in the app. If the project's
story bible is a git submodule — its `wiki/` folder has its own history — the clone needs
`--recurse-submodules`:

```
git clone --recurse-submodules https://github.com/you/rooftop.git
```

A clone made without it opens with the wiki folder empty; the app reports the story bible
as not checked out, and `git submodule update --init` inside the project fixes it. Each of
you then connects the same address as a shared copy (a clone already has it, as `origin`)
and the two of you take turns: send, and the other gets before sending.

Nothing about a save carries a machine's identity beyond git's own author name and email,
which git reads from `user.name` and `user.email`. Set those once per machine
(`git config --global user.name "…"`) so a collaborator's saves say who made them.

## Limits

- **Repository size.** `vngen/` is committed by design, so a project's history grows by
  every picture the pipeline draws, and a send uploads all of it. GitHub refuses a single
  file over 100 MB and a repository over a few gigabytes. The app does not yet warn at a
  threshold; a project that draws thousands of assets is better shared through a folder on
  a drive than through GitHub.
- **Git version.** The app needs git 2.13 or newer for the history reads it makes, and
  says so at startup when the installed one is older.
- **Repeated collisions.** A file git never merges (a layout, a graph) that both of you
  changed collides once per replayed save that touched it, so ten unsent saves that each
  moved a graph node ask the same question ten times. The app leaves git's `rerere` off,
  so no answer is applied on your behalf without being seen; the `Replaying N of M`
  heading says how many are left.
