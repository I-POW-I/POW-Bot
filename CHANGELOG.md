# Changelog

## 5.5.0

- **Security Check Point**: a trap channel that catches spam bots and hacked accounts. Set it up in `/setup` > Security Check Point. Press **Create the channel for me** and it is on. Staff choose what happens to anyone who posts there (softban is the default, or kick, ban, timeout), where it is logged, and which roles are never actioned. **Test it** checks permissions and sends a sample log entry
- New permissions: Ban Members, Timeout Members and Manage Channels. The new permission number is `1099783335062`. Existing servers keep working, and `/setup` tells staff if a permission is missing for the action they chose
- Streamer alerts recover on their own: if a live post was deleted or lost during a restart, the bot posts it again and keeps it updated, and it now logs when an update fails instead of failing silently
- Fortnite and Blizzard game updates removed. Existing alerts for them are deleted automatically
- After adding a game update alert, its page opens straight away with the **Send latest post as a test** button
- Help text corrected (free games include GOG)

## 5.4.2

- `/botinfo` is now a short public post for everyone: status, latency, uptime, version and whether the bot is in voice there. The bot owner also gets the full system details, privately. Fixes the "Unable to show bot info" error
- `/leaderboard`, `/streamers` and `/botinfo` are posted in the channel. `/leaderboard` has a period option (all time, 7 or 30 days)
- Voice and live stats are kept until the bot leaves a server. A server can opt in to a yearly reset on 1 January in `/setup` > Voice leaderboard
- Steam free games now come straight from the Steam store, in the same layout as PatchBot: price, release date, reviews and platforms. Games that need another account are no longer posted
- Game updates: **Send latest post as a test** in `/setup` > Game updates > Manage alerts, and the add confirmation points to it

## 5.4.1

- Durations read naturally everywhere: `1 day 1 hour 10 minutes` instead of `34h 10m`
- Voice panel redesigned: status, channel, members in voice, connected time, uptime and memory, with the top three this week at the bottom
- Voice leaderboard and `/streamers` lists spaced out so they are easier to read
- Free games: Epic, Steam and GOG each have their own on/off button in `/setup` > Free games. `/free-games` shows all three
- Deleted POW-Bot log messages are now logged like any other deleted message

## 5.4.0

- Game update posts redesigned: game name, linked title, large section headings, sub-headings and bullet lists, a small game icon, and the Read full notes and Open store page buttons
- Optional weekly or monthly voice leaderboard post, set up in `/setup` > Voice leaderboard > Scheduled post
- `/privacy`: see what the bot has stored about you and delete it
- Stored data now ages out: join and leave history after 90 days, voice and live sessions after 1 year (voice time is kept as a total). Everything for a server is deleted when the bot is removed from it
- Permission check now flags a bot role that sits low in the role list and channels the bot cannot see or join
- Weekly backup of the whole application (without `.env`) to the owner's DMs, plus a Back up now button in `/owner`
- Timestamps removed from posts that already show their send time
- Subtle emoji added back to menus, log titles and status lines
- `npm run check` loads every file before you push. `deploy-commands.js` removed: commands register themselves on start

## 5.1 to 5.3

Added or improved

- Streamer, game update and free game alerts are set up in `/setup` with everything else
- Voice leaderboard on the panel and as `/leaderboard`, with role rewards for voice time (preset ladders or your own hours, roles created for you)
- Game update alerts for Steam, Minecraft (Java and Bedrock), Riot, Fortnite, Blizzard and any RSS or Atom feed
- Welcome and leave messages can be edited: card on or off, title, subtitle, colour and message text
- Deleted and edited message logs keep the text for 7 days so they always work, with an optional log for messages deleted from other bots
- `/changelog` shows what has changed in the bot
- Bot status shows server count, member count and hours spent in voice
- Owner announcements: changelog, update, maintenance, incident and event styles, sent to servers and channels chosen each time

Fixed

- Verify button errors when someone clicked twice
- Staff could still press Approve or Kick on a member who had already verified
- One broken command file could stop the whole bot from starting
- The setup permission check missed Read Message History

Removed

- The Bot Info panel button, the subcommands of `/streamers`, `/game-updates` and `/free-games`, and voice channel names in the bot status
