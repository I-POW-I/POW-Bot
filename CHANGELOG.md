# Changelog

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
