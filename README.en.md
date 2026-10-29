# dsh-life-diary

Two journals a day, stored wherever **you** choose.

| | File | Written by | When |
| --- | --- | --- | --- |
| The agent's own book | `me/YYYY-MM-DD.md` | the plugin | a turn ends and nothing arrives for three minutes; or on demand |
| The book for you | `owner/YYYY-MM-DD.md` | the plugin | at day rollover (default 07:45) |

「The agent's own book」 is a scratchpad — fragments, half-sentences, not meant to be complete.
「The book for you」 is distilled from that book at rollover; the whole day's conversation is never re-read.

## Why this is not memory

Memory has to be recalled and compacted every turn. A diary is written once and left alone: it is never injected into context, never compressed, and only read when something asks for it.

So a diary costs nothing per turn.

## Where it lives

Pick one:

- **A local folder** (default) — no configuration, works immediately. Only this machine can see it.
- **A private GitHub repository** — needs a repository and a token. **Public repositories are rejected**, because a diary is not for publishing.
- **WebDAV** (Nextcloud, Synology, Jianguoyun…) — point it at a server and credentials.

If you need to read the same diary from more than one machine, pick one of the two remote options.

## Two hard rules

1. **If the agent's own book is empty, the book for you is not written.** Nothing is invented.
2. **A summary is not a copy.** It keeps what is worth saying and leaves out what is too private or too rough.

## Cost

- A fragment: one small, self-contained context — the day's conversation is not re-read.
- A summary: once a day, reading only the previous day's own book.
- `diary_note`: no model call at all.
- Reading a range: recent 7 days is light; a whole month is heavier, and **what you read stays in that conversation** until you start a new one.

## Time zone

All dates follow the user's time zone, never the server's. A container is often on UTC while the user is eight hours away, and that silently writes entries into the wrong day.

The plugin guesses from the machine; you can override it in settings.

## Known limits

- A local diary does not sync anywhere by itself.
- One machine per storage location is recommended, even though appends are version-checked.
- 「Read the diary」 exists for the agent's recall. To read the original, just open the folder.

## License

MIT.
