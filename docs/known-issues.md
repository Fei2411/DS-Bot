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

## DS Bot does not load: "disabling profile plugin row "bot""

**Where:** DSH Web (or Desktop) starts, but DS Bot is not there. The log has this line:

```text
dsh: disabling profile plugin row "bot": its declared peer dependencies cannot be validated: Cannot read properties of undefined (reading 'startsWith')
```

Installing another version of DS Bot does not help.

**Why:** before it loads a plugin, DeepSeek Harness checks each plugin row of the profile. This message means a row has the id `bot` but no package name. DS Bot adds its own row with the name `ds-bot`, so the row without a name most likely comes from a file in the profile folder, such as an override `- id: bot` in `cordis.patch.yml` that no longer matches DS Bot's row. We could not reproduce this, so we do not know yet how such a row is left behind.

**What to do:** the profile folder is `~/.dsh/profiles/web/` (Windows: `C:\Users\<user>\.dsh\profiles\web\`), or `profiles/web/` in `DSH_HOME` when it is set. For Desktop, use `profiles/desktop/` instead.

1. Quit DSH.
2. Open `cordis.patch.yml` in the profile folder. Look for a row with `id: bot` that has no `name: ds-bot` line, and remove that row. Keep a copy of the file first.
3. Check that `package.json` in the same folder lists `ds-bot` under `dependencies`. If it does not, add DS Bot again: `npx @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add ds-bot`.
4. Start DSH again.

To see where the row comes from, run `npx @deepseek-ai/dsh@0.2.1-rc.4 --profile web --dump-config`. It prints every plugin row with the file that supplied it. If you report the problem, copy only the rows with `id: bot` and the file names; leave out keys and paths you do not want to share.

Deleting the whole profile folder also fixes it, but it removes the profile's other plugins and its settings, such as models. The Bot team is in `~/.dsh/bot/` and is not affected either way.

## Web search fails everywhere after turning off "web-search-auto"

**Where:** every session, Bot chats and normal Agent chats alike, after you turn off the `web-search-auto` row in the sidebar's Plugins page or with `disabled: true` in the profile's `cordis.patch.yml`. Each `web_search` call returns:

```text
Error: configured web provider "auto" is not registered
```

The error code is `WEB_PROVIDER_CONFIGURED_MISSING`.

**Why:** DS Bot's `cordis.patch.yml` sets the `web` row's `searchProvider` to `auto` whether or not the `web-search-auto` row is on, and DeepSeek Harness does not fall back to another provider when the one it names is missing.

**What to do:** the profile folder is the same as in the entry above.

1. Quit DSH.
2. Open `cordis.patch.yml` in the profile folder. Next to the row that turns off `web-search-auto`, add a `web` row that names another search provider. This row replaces the whole config of the `web` row, so keep `fetchProvider` in it:

   ```yaml
   - id: web-search-auto
     name: ds-bot/web-search
     disabled: true
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: deepseek-official
       fetchProvider: http
   ```

3. Start DSH again.

To check the result, run `npx @deepseek-ai/dsh@0.2.1-rc.4 --profile web --dump-config` and look at the `web` row. Another plugin can also set the search provider while DSH runs, after the profile patch. If you turn such a plugin off later, check this setting again.

See also [Web search](../ds-bot/README.md#web-search) in the plugin README and issue [#128](https://github.com/Fei2411/DS-Bot/issues/128).

## Linux: "GLIBC_2.27 not found" loading libghostty-vt.so

**Where:** on a Linux system whose glibc is older than 2.28 (CentOS 7 ships glibc 2.17), the desktop AppImage or deb, or a host-installed `dsh web`, fails at start. The loader reports a missing glibc version, for example:

```text
libghostty-vt.so: GLIBC_2.27 not found
```

**Why:** DeepSeek Harness ships native libraries, including `libghostty-vt.so`, built against newer glibc symbols than CentOS 7 provides. DS Bot is a plugin and cannot rebuild DSH's libraries, so there is no glibc-2.17 build to install. Check your version with `ldd --version`.

**What to do:** run the Docker image instead — the container has its own, newer glibc, so the host's glibc no longer decides. See [`docker/`](../docker/README.md): build or pull the image, publish the port, and open the UI from any browser on the LAN. Keep these points in mind:

- The container brings its own DSH and its own native libraries. Do not copy or mount the host's `libghostty-vt.so` into the container — mixing them breaks it.
- The container needs a Docker (or Podman) new enough to run a Debian Bookworm image. CentOS 7's stock kernel and Docker are old; if Docker itself fails, Podman or a newer Docker engine is the route. This exact combination is untested — the image itself is covered by CI on a modern host.
- Data lives in the mounted data directory (`/data`), not your real `~/.dsh`; the container never reads or writes it.
- Stop with `docker compose down` (or `docker stop`), which flushes sessions cleanly.
