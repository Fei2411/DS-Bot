# Known issues

English | [中文](known-issues.zh.md)

## "@Name" shows as a file in a message that is not sent yet

**Where:** your own message while it waits: just after you press Send, or while it waits in the queue for a Bot that is busy.

**What you see:** DeepSeek Harness draws the "@" part of that message as a file reference, with a file icon. In these cases it also cuts the name:

| You type | Shown while waiting |
| --- | --- |
| `@New Bot please check` (a name with a space) | a file "New", then "Bot please check" |
| `@Anvil你看下` (no space after the name) | a file "Anvil你看下" |
| `@Anvil，帮我查` (punctuation after the name) | a file "Anvil，帮我查" |

**What is not affected:** who answers. DS Bot reads "@Name" by its own rule, so the Bot you named is called. When the message is sent, it shows the Bot's mark and name as usual.

**Tip:** put a space after the name (`@Anvil 你看下`). Then a name without a space shows as the Bot while it waits, too.

**Why:** DeepSeek Harness draws these waiting rows itself and reads "@" up to the next space. A plugin cannot change how they are drawn yet.
