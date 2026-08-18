# Getting an API key

<!-- toc -->

- [Gemini](#gemini)
- [Anthropic](#anthropic)
- [Where a key goes](#where-a-key-goes)
- [Keeping a key safe](#keeping-a-key-safe)

<!-- tocstop -->

VN Generator does not host any models. It calls Google's Gemini and Anthropic's Claude with
**your** account, so before it can write a line or draw a frame it needs one key per provider.
This page is the walkthrough, and it is the **only** copy of it: the desktop app's Setup pane
renders this file, and anything printable is generated from it. Fix a step here and every place
that shows it is fixed.

You need both. Claude writes and revises the screenplay; Gemini draws. A key for one gets you
half an app.

## Gemini

```yaml
vendor: gemini
name: Google Gemini
console: https://aistudio.google.com/apikey
docs: https://ai.google.dev/gemini-api/docs/api-key
billing: https://ai.google.dev/gemini-api/docs/pricing
env: GEMINI_API_KEY
freeTier: true
```

1. Open the console link above and sign in with a Google account.
2. Choose **Create API key**. If it asks which Google Cloud project the key belongs to, pick an
   existing one or let it make you a new one — either is fine, and the choice only matters for
   billing later.
3. Copy the key. It begins with `AIza`, and the console shows it in full exactly once; after
   you close the dialog you can only delete it and make another.
4. Paste it into the Setup pane, or write it to a file yourself — see
   [Where a key goes](#where-a-key-goes).

**Money.** Gemini has a free tier, so a first run costs nothing, but it is rate-limited hard
enough that a real project will hit it. Enabling billing on the key's Cloud project lifts the
limits and switches you to pay-as-you-go pricing.

## Anthropic

```yaml
vendor: anthropic
name: Anthropic Claude
console: https://platform.claude.com/settings/keys
docs: https://platform.claude.com/docs/en/get-started
billing: https://platform.claude.com/docs/en/about-claude/pricing
env: ANTHROPIC_API_KEY
freeTier: false
```

1. Open the console link above and sign in, or create an account.
2. Go to **Settings → API keys** and choose **Create key**. Give it a name you will recognise in
   six months — "vn generator" beats "key 1".
3. Copy the key. It begins with `sk-ant-`, and like Gemini's it is shown once.
4. Paste it into the Setup pane, or write it to a file yourself — see
   [Where a key goes](#where-a-key-goes).

**Money.** There is no free tier. A brand-new account has no credit balance, and every call
fails with a credit-balance error until you buy some under **Billing** in the console. This is
the single most common reason a freshly pasted key appears not to work.

## Where a key goes

A key is read from the first of these that has one, so a project that carries its own key always
wins:

1. The **environment variable** named in `project.yaml` — `GEMINI_API_KEY` and
   `ANTHROPIC_API_KEY` unless the project renamed them.
2. The **project's** `keys/` directory: `keys/gemini.txt`, `keys/claude.txt`. The directory is
   added to `.gitignore` before anything is written to it.
3. The **enclosing repository's** `keys/`, for a workspace holding several projects.
4. **Your own** `keys/`, which is not inside any repository — the answer that is right the
   second time, and what the Setup pane writes by default:

   | Platform | Directory                                          |
   | -------- | -------------------------------------------------- |
   | Windows  | `%LOCALAPPDATA%\vnauthor\keys`                     |
   | macOS    | `~/Library/Application Support/vnauthor/keys`      |
   | Linux    | `$XDG_CONFIG_HOME/vnauthor/keys`, else `~/.config/vnauthor/keys` |

   Setting `$VNAUTHOR_HOME` moves all four of those somewhere you choose.

The file holds the key and nothing else — one line, no quotes, no `export`.

**A set environment variable wins over a file you just wrote.** If the app keeps saying a key is
missing, or keeps using a key you thought you had replaced, that is almost always why; the Setup
pane names the source it actually read, so it will tell you.

## Keeping a key safe

- Never commit one. `keys/` is gitignored, the user-level directory is in no repository, and
  the command history records the value as `<secret>` — but a key pasted into a scene, a wiki
  page or a commit message is in git forever.
- Both consoles let you revoke a key and issue a new one, which is the fix if one does leak.
  Revoking is instant and costs nothing.
- A key is per-machine by design here: the user-level directory is the local one on Windows
  rather than the roaming one, so a key does not follow a domain account to another computer.
