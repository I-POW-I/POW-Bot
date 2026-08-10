# POW-Bot

A Discord bot that sits in a voice channel and stays there 24/7. Keeps call timers running, logs all voice activity, and has live control panel.

---

## What it does

- Joins a voice channel and stays connected permanently
- Plays a silent audio stream to prevent Discord from dropping the connection
- Instantly Auto-rejoins the last known VC if the bot's host connection drops or discord breaks
- Instantly Auto-rejoins the last known VC on restart, so worrying about it leaving during a restart, update or change isn't a issue.
- Logs all voice activity to a chosen channel
- Logs deleted messages
- Live control panel embed with buttons
- Updates its Discord status with the channel name and uptime
- Persists uptime stats across restarts

---

## Commands

| Command | What it does | Permission |
|---|---|---|
| `/panel` | Post the live control panel in this channel | Manage Server |
| `/setlogchannel` | Set which channel a log type posts to | Manage Server |
| `/ping` | Show's current connection ping | Everyone |
| `/clearcommands` | Force clear and re-register all slash commands | Administrator |
| `/serverinfo` | Show's useful information about the server | Everyone |
+ plenty more!!

---

## Control Panel Buttons

| Button | What it does | Permission |
|---|---|---|
|  Join | Joins your selected VC | Manage Server |
|  Leave | Disconnect's from VC | Manage Server |
|  Leave & Reset | Disconnect's from the current VC then wipes all previous state — fixes connection issues | Manage Server |
|  Panel Refresh | Refreshes the panel embed | Everyone |
|  User Info | Show's information about others. Post's time spent in the server, time spent in VC etc... | Everyone |
|  My Info | Show's information about yourself. Post's time spent in the server, time spent in VC etc... | Everyone |
---

