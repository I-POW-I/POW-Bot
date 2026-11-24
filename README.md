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
- Voice leaderboard with optional role rewards for voice time
- Owner announcements (changelogs, updates, maintenance notices) sent to servers you choose
- Human verification with staff approval and audit logging
- Persists uptime stats across restarts

---

## Commands

| Command | What it does | Who |
|---|---|---|
| `/setup` | Set up everything in one place: voice panel, logs, welcome and leave, verification, bot control role, streamer alerts, game update alerts, free game alerts, voice leaderboard and announcements. Includes a checklist and a permission check | Manage Server |
| `/help` | What every command does, by topic | Everyone |
| `/botinfo` | Full bot status, latency, resources, services and last error | Manage Server, bot owners |
| `/leaderboard` | Who has spent the most time in voice here (all time, 30 days, 7 days) | Everyone |
| `/changelog` | What changed in the bot recently | Everyone |
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

## Voice leaderboard and rewards

The leaderboard is always available from the panel and `/leaderboard`. Time in the server's AFK channel is not counted. In `/setup` > Voice leaderboard, server staff can turn on role rewards: pick a ladder (Standard, Casual, Dedicated or their own hours), and either let the bot create the roles or choose existing ones. Members hold the role for the highest tier they have reached. The bot needs **Manage Roles**, and its own role must sit above the reward roles.

---

## Logs

`/setup` > Logs sets a channel for each log type. **Deleted bot messages** is a switch (off by default) that also logs messages deleted from other bots; this bot's own messages are never logged.

---

## Control Panel Buttons

| Button | What it does | Permission |
|---|---|---|
| Join | Joins your voice channel | Manage Server |
| Leave | Disconnects from the voice channel | Server owner / bot control role |
| My info | Your time in the server and in voice, streaks | Everyone |
| User lookup | The same, for someone you pick | Everyone |
| Leaderboard | Who has spent the most time in voice, for all time, 30 days or 7 days | Everyone |

---


