# Gaffer — FPL rival tracker

A phone-first web app for Fantasy Premier League that installs on Android like a normal app.

- **Home** – your GW score (live), rank, deadline countdown, a "to do this week" list (injuries in your squad, captain pick, best transfer) and a card for each league you want to win.
- **My team** – your squad on a pitch with next fixture and projected points, captain picks (with % of rivals captaining each), transfer ideas, and a stats table (xGI/90, ownership, rival ownership, fixture run).
- **Leagues** – for each league you track: a game plan in plain English, a table comparing you with the rivals above and just below you (gap, live GW points, projected points, shared players, captain, chips left, team value, hits), the players they own that you don't ("threats"), and your differentials. Tap a rival to see their squad, transfers and chips.
- **Insights** – top projected players by position, a fixture ticker, "due a goal" (xG above goals), players running hot, xGI per 90 leaders, differentials, value picks, most transferred in/out and price changes.
- **Creators** – follow FPL YouTubers (Let's Talk FPL and FPL Harry are set up; add more): their latest videos, their FPL squad, captain, transfers and chips, and the players they own that you don't. Add each creator's FPL team ID or team link in the app.
- **News** – injury and availability news for your players and your rivals' players, plus headlines from Fantasy Football Scout, BBC Sport, The Guardian and Sky Sports (headline + link to the original).
- **Updates** – "since you last checked": rank changes, rival transfers and chips played. Optional notifications when the app is opened, plus a 24-hour deadline reminder.

## Where the data comes from

- **Official FPL API** (`fantasy.premierleague.com/api`) for players, prices, fixtures, your team, leagues and rivals. No login needed, just your team ID.
- **Opta stats** come through the FPL API: FPL's expected goals, expected assists, expected goals conceded, defensive contributions, BPS and bonus are Opta-supplied. Opta's full raw feed is a paid licence and isn't used.
- **Fantasy Football Scout** and other sites are shown as headlines that link to the full article. Their members' content isn't copied.

### How "xP" (projected points) works
For each upcoming match: chance of playing (FPL injury flags plus start rate) × expected minutes × the player's per-90 xG, xA, xGC, saves, bonus and defensive contributions, using FPL scoring rules, then adjusted for fixture difficulty and home/away. Small samples are blended with the position average. Blank and double gameweeks are handled.

"Gain vs rivals" in transfer ideas counts only points your rivals won't also get: projected points × (1 − share of your rivals who own the player).

## Run it

Needs Node 18 or newer. No packages to install.

```bash
npm start            # http://localhost:3000
```

Open it, enter your FPL team ID (on the FPL site go to **Points**; the number after `/entry/` in the address), tick the leagues you want to win, done.

### Put it online (needed to use it on your phone)
The server is required because browsers can't call the FPL API directly.

- **Render** (free): push this folder to a GitHub repo, then on render.com choose *New → Blueprint* and pick the repo (`render.yaml` is included).
- **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t gaffer . && docker run -p 3000:3000 gaffer`

### Android app
The `android/` folder is a small native app that opens your hosted Gaffer full-screen. Your server address is set in `android/app/src/main/res/values/strings.xml` (`app_url`).

**Easiest: download the APK GitHub builds for you.** Every change to `android/` builds a new APK and publishes it under **Releases**. On your phone open
`https://github.com/<you>/<repo>/releases/latest` → tap **gaffer.apk** → open it → allow "install unknown apps" once.
You can also start a build by hand: **Actions → Build Android app → Run workflow**.

**On your own laptop:** install [Android Studio](https://developer.android.com/studio), choose **Open**, pick the `android` folder, wait for it to sync, then **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. Or plug your phone in (USB debugging on) and press ▶ Run.

The signing key (`android/app/gaffer.keystore`) is committed so updates install over the old version. It's fine for a personal app; make a new private key before publishing to the Play Store.

**Without the APK:** open your hosted URL in Chrome → **⋮ → Install app**.

## Settings you can change
- Rivals above / below you to compare (default 5 above, 3 below)
- How many gameweeks to plan ahead (default 5)
- News feeds: set `NEWS_FEEDS` to a JSON list of `{ "source", "url", "fpl" }`

## Testing
```bash
npm test                          # analytics unit tests
npm run mock & npm run dev:mock   # full app against a fake FPL API; test team ID 1005
```

## Notes
- Budget for transfer ideas uses current prices; your real selling prices can be up to £0.1m–£0.2m lower per player (the FPL API only shows these when logged in).
- Live points don't include auto-subs.
- Not affiliated with the Premier League, FPL, Opta or any publisher. The FPL API is unofficial-to-use; the server caches responses to stay polite.
