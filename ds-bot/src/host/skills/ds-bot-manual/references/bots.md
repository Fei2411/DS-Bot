# Bots, roles and characters

A Bot is a long-lived identity with its own chat, instructions, model, working folder and memory. The **Label** is a short description under its name. It does not grant permissions. **Main Bot** is an administrative right, not just a label.

## Where and how

Open **Settings → Bots** and select a Bot. **Profile** contains **Name** and **Label**. **Instructions** define its work. **Working folder → Folder** sets where file tools and commands start. The avatar editor offers **Bot**, **Upload** and **Library**; **Reset** restores the default character.

Call `list_bots` to inspect the team. Call `update_bot` without bot to change yourself. Supported fields include name, role, instructions, color, avatar, model, effort and work_dir. Instructions replace the old text; preserve rules the user still wants. Use an absolute working folder, such as /opt/projects/site. An empty work_dir returns to the team workspace. A folder change can need user approval.

Only a Main Bot can call `create_bot` or change another Bot with `update_bot`. Check for duplicates first. Do not invent a model preference: pass model or effort when the user names one. Only the user deletes a Bot or changes Main Bot status. There can be several Main Bots.

## Private Bots and local agents

The user controls **Privacy → Private**. Give private work a separate folder. Other Bots cannot read a private Bot's folder, memory or history. Sending messages out or writing outside its folder requires approval. A private Bot cannot be a Main Bot or join a group. Deleting it does not automatically release its protected records and folder. This is a team boundary, not an OS sandbox: shell and network access still matter.

The user can choose **Local agent** when creating or configuring a Bot. This uses an installed CLI's sign-in, models, tools and context. Only the user switches between DS Bot models and a local CLI, or between CLIs. There is no update_bot field for that route switch.

## Common problems

- A role named “Main” does not make a Bot a Main Bot. Ask the user to review its actual rights.
- A changed folder is not a permission grant for every file on disk. Respect approval cards.
- A local agent's tools and context differ from shared DSH tools. Check the CLI's setup in **Settings → Local agents**.

Sources: README.md (Bot, Main bot, Private bot, Local agents); src/client/bot-settings.js; src/host/tools.js; docs/plans/2026-10-27-private-bots.md.
