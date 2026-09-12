# OmaGram for Omarchy

OmaGram puts Telegram in the Omarchy Quattro bar. It shows an unread badge, sends clickable desktop notifications, lists recent chats, and lets you read and reply from the panel. The full Telegram Desktop client is one click away for calls, search, and anything the panel does not handle.

## How it works

| Piece | Job |
|-------|-----|
| Bridge daemon (Node.js + [`teleproto@1.229.0`](https://www.npmjs.com/package/teleproto)) | Logs in to Telegram over MTProto, keeps chat state, sends notifications, and handles messages and read receipts |
| Bar plugin (QML) | Shows the badge, chat list, conversation view, login controls, and reply box |

The two processes exchange NDJSON over a Unix socket in `$XDG_RUNTIME_DIR`. No localhost port is opened. The daemon holds the Telegram session, so bars on several monitors share the same state and notification clicks can select a chat in the panel.

## Install

```sh
omarchy plugin add https://github.com/TerrifiedBug/omagram.git --enable --yes
```

The first start installs the daemon dependencies, creates the `omarchy-omagram.service` user service, and links the command-line tools into `~/.local/bin`.

From a source checkout:

```sh
git clone https://github.com/TerrifiedBug/omagram.git
cd omagram
./install.sh
```

OmaGram requires the Omarchy Quattro shell, Node.js 20 or newer, and `jq` for the terminal login flow. Setup checks `PATH` and common mise, proto, fnm, Volta, and Bun locations for Node, then records the selected path in the user service. Telegram Desktop is the default full client.

## Get an `api_id` and `api_hash`

Telegram requires each user to supply an application ID and hash:

1. Sign in at [my.telegram.org](https://my.telegram.org/apps).
2. Open **API development tools** and create an application.
3. Copy its `api_id` and `api_hash` into the OmaGram login form, or enter them when `omarchy-omagram login` asks.

You must create your own credentials. Publishing one shared credential in a public plugin can cause Telegram to reject it with `API_ID_PUBLISHED_FLOOD`, so OmaGram does not bundle one. The daemon saves your values in `~/.local/state/omarchy-omagram/api.json` with mode `0600`.

## Log in

### QR code

Click the OmaGram icon. Enter your API credentials if asked, then scan the QR code from **Telegram > Settings > Devices > Link Desktop Device**. If your account has two-step verification, the panel asks for your password after the scan.

The terminal flow shows the same QR code:

```sh
omarchy-omagram login
```

The daemon removes an unused QR after five minutes. Start login again to get a new one. You can change the window with a systemd override:

```sh
systemctl --user edit omarchy-omagram.service
# Add: Environment=OMARCHY_OMAGRAM_PAIRING_WINDOW_MS=600000
```

### Phone and code

Pass your phone number in international format:

```sh
omarchy-omagram login --phone +441234567890
```

The command asks for the code sent through the Telegram app or by SMS. It also asks for your two-step verification password when enabled. API hashes, login codes, and passwords are sent to the daemon over standard input, so they do not appear in the process argument list.

## Use the panel

| Action | How |
|--------|-----|
| Open or close the panel | Click the bar icon |
| Move through chats | `j`, `k`, or the arrow keys |
| Refresh | Use the refresh button or press `r` |
| Open a chat | Click it or press `Enter` |
| Reply | Type a message and press `Enter` |
| Return to the chat list | Press `Escape` |
| Close the panel | Press `Escape` from the chat list |
| Open or focus Telegram Desktop | Right-click the bar icon or use the ⧉ button |
| Log out | Use the power button in the chat list |
| Open a chat from a notification | Click the notification |
| View a downloaded photo | Click its preview |

Opening a chat sends a read receipt to Telegram. Messages that arrive while that conversation is open are marked read as they arrive.

## CLI

The `omarchy-omagram` dispatcher supports these commands:

| Command | Purpose |
|---------|---------|
| `login [--phone <number>]` | Log in with a terminal QR, or use phone, code, and password prompts |
| `open` | Open or focus Telegram Desktop, or the configured Telegram Web app |
| `focus <chatId>` | Open the bar panel on a chat |
| `status` | Print connection state, account details, and unread count as JSON |
| `send <chatId> <text...>` | Send a text message |
| `logout` | End the Telegram session and clear chat and media state; keep `api.json` for the next login |
| `reconnect` | Disconnect and reconnect the daemon |
| `read <chatId>` | Mark a chat as read |
| `chats [n]` | Print recent chats as JSON |
| `refresh` | Refresh chats from Telegram |
| `messages <chatId> [n]` | Print recent messages from a chat as JSON |
| `ping` | Check whether the daemon is responding |
| `ctl <...>` | Pass a command to the raw daemon control client |
| `setup` | Install daemon dependencies, the user service, and CLI links |
| `uninstall` | Stop the service and delete OmaGram credentials and local data |
| `start` | Start `omarchy-omagram.service` |
| `stop` | Stop `omarchy-omagram.service` |
| `restart` | Restart `omarchy-omagram.service` |
| `logs [-f]` | Show the latest 100 daemon journal lines, optionally following them |

Telegram chat IDs are decimal strings. User IDs are positive, group IDs are negative, and channels or supergroups use the `-100...` form. Get them from `omarchy-omagram chats`.

`omarchy-omagram ctl` calls the same raw client as `omarchy-omagram-ctl`. It accepts:

| Raw command | Purpose |
|-------------|---------|
| `status` | Connection state, linked account, and unread count |
| `chats [limit]` | Recent chats |
| `refresh [chatId] [limit]` | Refresh chats, optionally loading one conversation |
| `messages <chatId> [limit]` | Recent messages from one chat |
| `send <chatId> <text...>` | Send a text message |
| `read <chatId>` | Mark a chat as read |
| `focus <chatId>` | Select a chat in open bar panels |
| `login` | Start QR login |
| `loginPhone <phone>` | Start phone login |
| `code` | Read one login code from standard input |
| `password` | Read one two-step verification password from standard input |
| `api` | Read `api_id` and `api_hash` from standard input, one per line |
| `reconnect` | Reconnect to Telegram |
| `logout` | End the Telegram session and clear local chat state |
| `ping` | Check whether the daemon is responding |

The setup command and the first widget start create the command links in `~/.local/bin`.

## Settings

Widget settings live on the bar entry in `~/.config/omarchy/shell.json` and reload when the file changes:

```json
{ "id": "io.github.terrifiedbug.omagram", "showUnreadCount": true, "chatLimit": 40 }
```

| Key | Default | Meaning |
|-----|---------|---------|
| `socketPath` | `""` | Daemon socket path; blank uses `$XDG_RUNTIME_DIR/omarchy-omagram.sock` |
| `autostartDaemon` | `true` | Start the daemon when the panel cannot reach its socket |
| `showUnreadCount` | `true` | Show the unread total beside the Telegram glyph |
| `hideWhenEmpty` | `false` | Hide the widget while the unread total is zero |
| `chatLimit` | `40` | Number of chats shown in the panel |
| `messageLimit` | `60` | Number of messages loaded when a conversation opens |
| `clientPattern` | `"org.telegram.desktop"` | Hyprland window class or title pattern used to focus Telegram Desktop |
| `clientCommand` | `"uwsm-app -- Telegram"` | Command used to launch Telegram Desktop when no matching window exists |
| `webAppUrl` | `""` | Telegram Web URL; blank uses Telegram Desktop |

Set `webAppUrl` to `https://web.telegram.org/k/` to use Telegram Web as the full client.

Move the widget with:

```sh
omarchy bar move io.github.terrifiedbug.omagram --section right
```

## Storage

| Path | Contents |
|------|----------|
| `~/.local/state/omarchy-omagram/session` | Telegram session (`0600`) |
| `~/.local/state/omarchy-omagram/api.json` | Your `api_id` and `api_hash` (`0600`) |
| `~/.local/state/omarchy-omagram/store.json` | Cached chats and recent messages (`0600`) |
| `~/.local/state/omarchy-omagram/daemon.pid` | PID of the running daemon (`0600`) |
| `~/.local/state/omarchy-omagram/qr.<n>.png` and `qr.txt` | Temporary login QR files (`0600`) |
| `~/.cache/omarchy-omagram/media/` | Photo previews from chats you have opened; each file is `0600` and limited to 12 MiB |
| `$XDG_RUNTIME_DIR/omarchy-omagram.sock` | Daemon control socket (`0600`) |

The state and media directories use mode `0700`. `OMARCHY_OMAGRAM_STATE`, `OMARCHY_OMAGRAM_MEDIA`, and `OMARCHY_OMAGRAM_SOCKET` can move them. Logging out removes the Telegram session and media cache, clears the chat store, and keeps `api.json`. Uninstalling removes the state and cache directories.

## Things worth knowing before you install

- OmaGram is an unofficial third-party MTProto client built on teleproto. It logs in as your account, and Telegram can associate its API use with that account. Telegram explains this in its [API ID documentation](https://core.telegram.org/api/obtaining_api_id). OmaGram is not affiliated with or endorsed by Telegram.
- The daemon leaves your presence state alone. It never calls `account.updateStatus` to force you online or fake an offline state. Telegram's API terms prohibit using the API for a ghost mode.
- Opening a chat sends a real read receipt. It has the same effect as opening that chat in another Telegram client.
- The daemon downloads only photos from chats you have opened. Each download is capped at 12 MiB. Other media stays as a text placeholder for the full client.
- Muted and archived chats do not send desktop notifications and do not count toward the bar badge. A timed mute begins counting again after it expires.
- Plugins run inside `omarchy-shell` without a sandbox. OmaGram keeps MTProto and network access in the separate Node.js daemon; the QML plugin exchanges JSON with that daemon over its Unix socket.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `OMARCHY_OMAGRAM_STATE` | `$XDG_STATE_HOME/omarchy-omagram`, falling back to `~/.local/state/omarchy-omagram` | State directory; the value must be an absolute path |
| `OMARCHY_OMAGRAM_MEDIA` | `$XDG_CACHE_HOME/omarchy-omagram/media`, falling back to `~/.cache/omarchy-omagram/media` | Photo cache directory; the value must be an absolute path |
| `OMARCHY_OMAGRAM_SOCKET` | `$XDG_RUNTIME_DIR/omarchy-omagram.sock`, falling back to `/run/user/<uid>/omarchy-omagram.sock` | Daemon socket path |
| `OMARCHY_OMAGRAM_NODE` | Auto-detected Node.js 20+ executable | Node executable used by the scripts and service |
| `OMARCHY_OMAGRAM_LOG_LEVEL` | `info` | Daemon log level |
| `OMARCHY_OMAGRAM_TG_LOG_LEVEL` | `error` | teleproto log level |
| `OMARCHY_OMAGRAM_NO_NOTIFY` | unset | Set to `1` to disable desktop notifications |
| `OMARCHY_OMAGRAM_NO_SOUND` | unset | Set to `1` to disable notification sounds |
| `OMARCHY_OMAGRAM_PRINT_QR` | unset | Set to `1` to print refreshed login QR codes in the daemon output |
| `OMARCHY_OMAGRAM_PAIRING_WINDOW_MS` | `300000` | QR or phone login window in milliseconds; values below `15000` are raised to `15000` |
| `OMARCHY_OMAGRAM_WEB_URL` | `""` | Full-client URL; a non-empty value opens Telegram Web |
| `OMARCHY_OMAGRAM_CLIENT_PATTERN` | `"org.telegram.desktop"` | Window pattern used by `omarchy-omagram open` |
| `OMARCHY_OMAGRAM_CLIENT_COMMAND` | `"uwsm-app -- Telegram"` | Desktop launch command used by `omarchy-omagram open` |

The widget supplies the last three variables from `webAppUrl`, `clientPattern`, and `clientCommand`. Set other variables in a user-service override, then restart the service.

## Troubleshooting

### Icon is dim or the panel says "Daemon offline"

```sh
systemctl --user status omarchy-omagram.service
journalctl --user -u omarchy-omagram.service -n 50
```

### `no Node.js >= 20 found`

Install `nodejs`, or point the service at a compatible interpreter:

```sh
systemctl --user edit omarchy-omagram.service
# Add: Environment=OMARCHY_OMAGRAM_NODE=/path/to/node
```

### API credentials are rejected

Copy the values from **API development tools** at [my.telegram.org](https://my.telegram.org/apps). The `api_id` is a positive integer. The `api_hash` is exactly 32 hexadecimal characters.

### Login is stuck

Run `omarchy-omagram login` again for a fresh QR. For phone login, include the country code and a leading `+`. Check the daemon journal if no prompt or QR appears.

### Connection is stuck reconnecting

```sh
omarchy-omagram reconnect
```

If Telegram revoked the session, log in again with `omarchy-omagram login`.

### Widget is missing from the bar

```sh
omarchy plugin list --json | jq '.[] | select(.id == "io.github.terrifiedbug.omagram")'
omarchy-shell shell rescanPlugins
qs log -p "$OMARCHY_PATH/shell" --tail 100
```

## Remove

```sh
omarchy plugin remove io.github.terrifiedbug.omagram
```

After the plugin directory is gone, the installed sweep service removes the user service, CLI links, state directory, and media cache at the next user-session start. To delete that data immediately, run the uninstall command while the plugin is still installed:

```sh
omarchy-omagram uninstall
omarchy plugin remove io.github.terrifiedbug.omagram
```

From a source checkout, you can run:

```sh
./install.sh --uninstall
```

Disabling the plugin stops and disables `omarchy-omagram.service` while preserving the Telegram session and cache for the next enable.

## License

MIT. See [LICENSE](LICENSE).

OmaGram is derived from [omarchy-whatsapp by ricky](https://github.com/srineshr1/omarchy-whatsapp), released under the MIT License.
