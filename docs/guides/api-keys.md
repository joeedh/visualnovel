# Getting an API key

<!-- toc -->

- [Gemini](#gemini)
- [Anthropic](#anthropic)
- [Where a key goes](#where-a-key-goes)
- [Keeping a key safe](#keeping-a-key-safe)

<!-- tocstop -->

VN Generator does not host any models. It calls Google's Gemini and Anthropic's Claude
with your account, so it needs one key per provider before it can write a line or draw a
frame. This page walks through the steps, and no other copy of that walkthrough exists:
the desktop app's Setup pane renders this file, and anything printable is generated from
it. Fixing a step here fixes every place that shows it.

You need both keys. Claude writes and revises the screenplay, and Gemini draws. With a key
for only one of them, half the app works.

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
2.  2. Choose **Create API key**. If asked which Google Cloud project the key belongs to,
       pick an existing one or create a new one. Either works, and the choice only matters
       for billing later.
3. Copy the key. It begins with `AIza`, and the console shows it in full exactly once;
   after you close the dialog you can only delete it and make another.
4.  4. Paste it into the Setup pane, or write it to a file yourself (see
       [Where a key goes](#where-a-key-goes)).

**Money.** Gemini has a free tier, so a first run costs nothing, but the rate limits are
low enough that a real project will reach them. Enabling billing on the key's Cloud
project lifts the limits and switches you to pay-as-you-go pricing.

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
2.  2. Go to **Settings → API keys** and choose **Create key**. Give it a name you will
       recognise in six months, such as "vn generator" rather than "key 1".
3.  3. Copy the key. It begins with `sk-ant-`. The key is shown once, as the Gemini key
       is.
4.  4. Paste it into the Setup pane, or write it to a file yourself (see
       [Where a key goes](#where-a-key-goes)).

**Money.** There is no free tier. A brand-new account has no credit balance, and every
call fails with a credit-balance error until you buy some under **Billing** in the
console. This is the single most common reason a freshly pasted key fails.

## Where a key goes

A key is read from the first source in this list that supplies one, so a project that
supplies its own key takes precedence:

1.  1. The environment variable named in `project.yaml` is `GEMINI_API_KEY` or
       `ANTHROPIC_API_KEY` unless the project renamed them.
2.  2. The project's `keys/` directory holds `keys/gemini.txt` and `keys/claude.txt`. The
       directory is added to `.gitignore` before anything is written to it.
3.  3. The enclosing repository's `keys/`, for a workspace holding several projects.
4.  4. Your own `keys/`, which is not inside any repository. This is the correct choice,
       and the Setup pane writes here by default:

    | Platform | Directory                                                        |
    | -------- | ---------------------------------------------------------------- |
    | Windows  | `%LOCALAPPDATA%\vnauthor\keys`                                   |
    | macOS    | `~/Library/Application Support/vnauthor/keys`                    |
    | Linux    | `$XDG_CONFIG_HOME/vnauthor/keys`, else `~/.config/vnauthor/keys` |

    Setting `$VNAUTHOR_HOME` moves all four of those to a location you choose.

The file holds the key on one line, with no quotes and no `export`.

An environment variable that is set takes precedence over a file you just wrote. If the
app reports that a key is missing, or uses a key you thought you had replaced, a set
environment variable is almost always the cause. The Setup pane names the source it
actually read.

## Keeping a key safe

- Never commit a key. `keys/` is gitignored, the user-level directory is in no repository,
  and the command history records the value as `<secret>`. A key pasted into a scene, a
  wiki page or a commit message stays in git forever.
- The agent cannot read `keys/`. Every document surface (the agent's `read_file`, the
  Documents editor, and the debug agent's source reader) returns "keys/ holds API
  credentials and is never readable." instead of the file, so no read can copy a key into
  a saved conversation.
- Both consoles let you revoke a key and issue a new one, which is how you recover from a
  leaked key. Revoking a key is instant and costs nothing.
- A key is per-machine by design. The user-level directory is the local one on Windows
  rather than the roaming one, so a key does not follow a domain account to another
  computer.
