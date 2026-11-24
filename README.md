# POW-Bot

A Discord bot that stays in a voice channel 24/7, keeps call timers running, logs voice activity and message changes, and gives servers a leaderboard, alerts, verification and a live control panel. One `/setup` command configures everything for server staff, and one `/owner` command gives the bot owner full control.

---

## What it does

- Joins a voice channel and stays connected, with automatic rejoin after a restart or a dropped connection
- Live voice control panel with Join, Leave, personal stats, user lookup and a leaderboard
- Voice leaderboard (all time, 30 days, 7 days) with optional role rewards and an optional weekly or monthly post
- Logs for voice activity, deleted and edited messages, members and server changes
- Welcome and leave cards, fully editable
- Human verification with staff approval, quarantine and auto-removal
- Moderation: warn, timeout, kick, softban, ban and unban as numbered cases with a history and a mod log, plus lock and slowmode
- Security Check Point: a trap channel that catches spam bots and hacked accounts and softbans, kicks, bans or times them out (staff choose)
- Streamer alerts (Twitch, Kick, YouTube), free game alerts (Epic, Steam, GOG) and game update alerts (Steam, Minecraft, Riot, any RSS feed)
- Owner tools: announcements, status editor, maintenance mode, alerts, weekly backups

---

## Commands

| Command | What it does | Who |
|---|---|---|
| `/setup` | Set up everything in one place, with a checklist and a permission check | Manage Server |
| `/help` | What every command does, by topic | Everyone |
| `/leaderboard` | Voice time ranking for the server | Everyone |
| `/changelog` | What changed in the bot recently | Everyone |
| `/privacy` | See what the bot has stored about you, and delete it | Everyone |
| `/serverinfo` | Details about the server | Everyone |
| `/members` | Overview, recent joins and leaves, unverified members, lookup | Manage Server |
| `/botinfo` | Status, latency, memory and services | Manage Server, bot owners |
| `/streamers`, `/game-updates`, `/free-games` | What the server follows. Staff get a Manage button | Everyone |
| `/warn` `/timeout` `/untimeout` `/kick` `/softban` `/ban` `/unban` | Moderation actions. Each one is a numbered case, recorded in the mod log, and the member is sent the reason | Matching Discord permission |
| `/case`, `/history` | Look up a case, or a member's whole record | Timeout Members |
| `/lock` `/unlock` `/slowmode` | Control a channel | Manage Channels |
| `/purge` | Delete up to 100 messages | Manage Messages |
| `/owner` | The owner control hub | `OWNER_IDS` / `ADMIN_IDS` only |

---

**General Information**

- Terms of Service URL and Privacy Policy URL: where `docs/TERMS.md` and `docs/PRIVACY.md` are published.

The permission list lives in `src/botPermissions.js`. If a feature needs a new permission, add it there and the integer, the owner server view and the setup checks all follow.

---

## Server setup advice

`/setup` > Permission check shows what is missing. The two things that cause most problems: keep the bot's own role near the top of the role list (it cannot manage roles or members above it), and do not block it in channel or category permissions.

---

## Data

What is stored and for how long:

- Stored message text: 7 days
- Join and leave history: 90 days
- Voice and live stats: kept until the bot leaves the server, unless the server turns on the yearly reset (1 January)
- Everything for a server is deleted when the bot is removed from it
- Members can delete their own data with `/privacy`

---

## Documents

- [Privacy policy](docs/PRIVACY.md)
- [Terms of service](docs/TERMS.md)
- [Changelog](CHANGELOG.md)
- [Licence](LICENSE)
