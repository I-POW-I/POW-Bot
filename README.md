# POW-Bot

A Discord bot that sits in a voice channel and stays there 24/7. Keeps call timers running, logs all voice activity, and has live control panel.

---

## What it does

- Joins a voice channel and stays connected permanently
- Plays a silent audio stream to prevent Discord from dropping the connection
- Instantly Auto-rejoins the last known VC if the bot's host connection drops or discord breaks
- Instantly Auto-rejoins the last known VC on restart, so worrying about it leaving during a restart, update or change isn't a issue.
- Logs all voice activity to a chosen channel
- Logs deleted and edited messages (message text is kept for 7 days so this always works)
- Live control panel embed with buttons
- Rotating Discord status managed by the bot owner (no server-specific details are shown)
- Streamer alerts, game update alerts and free game alerts, all set up from `/setup`
- Customisable welcome and leave cards
- Human verification with staff approval and audit logging
- Persists uptime stats across restarts

---

## Commands

| Command | What it does | Who |
|---|---|---|
| `/setup` | Set up everything in one place: voice panel, logs, welcome and leave, verification, bot control role, streamer alerts, game update alerts, free game alerts and announcements. Includes a checklist and a permission check | Manage Server |
| `/help` | What every command does, by topic | Everyone |
| `/botinfo` | Full bot status, latency, resources, services and last error | Manage Server, bot owners |
| `/serverinfo` | Detailed information about the server | Everyone |
| `/members` | Overview, recent joins and leaves, unverified members and per-member lookup | Manage Server |
| `/streamers` | Shows who the server watches and who is live. Staff get a Manage button that opens the setup page | Everyone |
| `/game-updates` | Shows the game update alerts for the server. Staff get a Manage button | Everyone |
| `/free-games` | Shows what is free now on Epic and Steam. Staff get a Manage button | Everyone |
| `/purge` | Delete up to 100 messages | Manage Messages |
| `/owner` | The bot owner control hub (see below) | `OWNER_IDS` / `ADMIN_IDS` only |

---

## Welcome and leave

`/setup` > Welcome & leave lets server staff choose the channel, switch the card and the message on or off, and edit the card title, subtitle, accent colour and message text. Placeholders: `{user}`, `{mention}`, `{server}`, `{count}`. Servers that change nothing keep the original look.


---

## Control Panel Buttons

| Button | What it does | Permission |
|---|---|---|
| Join | Joins your voice channel | Manage Server |
| Leave | Disconnects from the voice channel | Server owner / bot control role |
| My Info | Your time in the server and in voice, streaks | Everyone |
| User Lookup | The same, for someone you pick | Everyone |
| Bot Info | A short summary: status, uptime, latency, voice time here, version | Everyone |

---


