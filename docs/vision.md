# The vision of DS Bot

English | [中文](vision.zh.md)

This file says what DS Bot is meant to be and why. For how to use it, see the [README](../README.md); for the designs that are decided, see [docs/plans/](plans/) (written in Chinese); for how to take part, see [CONTRIBUTING](../CONTRIBUTING.md).

## What DS Bot is

DS Bot is a persistent team of Bots, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It is open source under the Apache 2.0 license. The user can chat with one Bot, or work with a team with clear roles: one or more Main Bots organize the work, every Bot does its own part and talks to the others, and the user can see at any time who is doing what. Bots keep working over time and have a long-term memory.

## Two forms

| Form | What it is |
|---|---|
| The `ds-bot` plugin | A standard DSH plugin for DSH Desktop and DSH Web. All the Bot features are here |
| The DS Bot desktop app | Opens straight into DS Bot itself. It brings a pinned DSH, its own profile and its own data folder, imports a team the user already has in DSH, and installs DSH-compatible plugins, so that DS Bot grows its own plugin ecosystem. The plugin can still be used on its own |

Both forms run the same `ds-bot` plugin. The point of the app is that DS Bot controls its own profile and interface, free of the limits of DSH's general interface and global settings (see the [DSH concessions](plans/2026-10-13-dsh-concessions.md)).

## Ten core requirements

1. **Built on DSH, independent of each other.** Every Bot is built on DSH, and the Bots are independent of each other.
2. **Reliable.** Bots work reliably: they stay aligned with the goal, act on evidence, stay inside their task, and their results can be checked. Bots will also be able to improve themselves (planned).
3. **Memory and persistence.** Bots keep working over time, that is, they have a long-term memory. A Bot can read the other Bots' memories but not change them (only a Main Bot can change another Bot's memory). A Bot manages its own memory, and the user can manage each Bot's memory too. A group chat shares one memory.
4. **Levels of rights.** A Main Bot has the highest rights: it creates and changes other Bots. Other Bots do not have these rights, and only the user deletes a Bot. There can be more than one Main Bot. Every Bot can call on every other Bot.
5. **Group chats.** Group chats are the core form of Bots working together in DS Bot. Bots in a group call on each other, and a group can have an admin Bot. The admin manages the group, adds and removes members, and by default answers the user's messages.
6. **Working folders.** Each Bot can have its own working folder, and a group chat can set one folder for all its members. A Bot can set its own working folder, so one sentence from the user is enough.
7. **Browser.** Each Bot has its own browser, and the browsers do not affect each other. Importing cookies is planned.
8. **Interface and motion.** DS Bot has a polished interface with smooth motion.
9. **A standalone app.** DS Bot is meant to be a standalone app and does not make too many concessions to DSH.
10. **Local agents.** DS Bot can bring local agent CLIs in as Bots that call on each other (planned).

## Principles for trade-offs

- **Correct Bot behavior comes first.** Where a DSH mode or limit does not fit Bots, DS Bot does not pile up complexity to stay compatible. Concessions that cannot be avoided go into the [DSH concessions](plans/2026-10-13-dsh-concessions.md), to be removed once the app controls its own profile.
- **Every request ends where the user can see it.** A message to a Bot, a task handed on, a key a Bot asks for: each one either finishes, or stops with a reason that the user can see and carry on from. Nothing is dropped silently; a limit set against runaway work pauses the work instead of dropping it.
- **Data stays on the user's computer.** Teams, chats and memory live in DS Bot's data folder on the user's computer.
- **Done means checked.** Behavior is covered by tests; interface changes are looked at for real.

## Who sets the direction

The maintainer decides the direction of the product, changes to decided designs, the rules for working together, releases and the architecture. Anyone can do the rest of the work; see [CONTRIBUTING](../CONTRIBUTING.md#how-we-work).
