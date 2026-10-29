# ASKBOT (free version)

A chat web app that installs on a phone like an app. It runs on free hosting and a free AI tier, so it costs nothing to start.

- `server.js` serves the page and sends chat messages to the AI provider. Your key stays here and never reaches the browser.
- `public/` is the chat page, app icons, and the files that make it installable.
- No packages to install. It needs Node 18 or newer.

## 1. Get a free AI key

The default is Groq. Create an account at https://console.groq.com, open API Keys, and create a key. No card is needed at the time of writing. Free tiers have daily and per-minute limits, and the terms change, so read the provider's current limits and data policy.

Prefer another provider? Any service with an OpenAI-style chat API works. See `.env.example` for Gemini and OpenRouter settings. Check the provider's docs for the current model name and set `MODEL` if the default no longer exists.

## 2. Try it on your computer

Mac or Linux:

    export LLM_API_KEY=your-key-here
    node server.js

Windows PowerShell:

    $env:LLM_API_KEY="your-key-here"
    node server.js

Open http://localhost:3000.

## 3. Put it online for free

1. Upload this folder to a GitHub repository (free).
2. On render.com choose New, then Web Service, pick the repository, and choose the Free instance type.
3. Build command: leave empty. Start command: `node server.js`.
4. Under Environment add `LLM_API_KEY` with your key.
5. Deploy. You get a link like `https://askbot-xxxx.onrender.com`.

On Render's free plan the app sleeps after a while without visitors, so the first load after a break can take up to a minute. Do not use static-only hosts such as GitHub Pages, because the server must run.

## 4. Install it as an app

- Android (Chrome): open the link and tap Install in the ASKBOT header.
- iPhone (Safari): open the link, tap Share, then Add to Home Screen.
- Desktop (Chrome or Edge): click the install icon in the address bar.

## Keeping it within free limits

- Each visitor is limited to 15 messages a minute (`RATE_LIMIT_PER_MINUTE`).
- Replies are capped at 1024 tokens, and only the last 20 messages are sent.
- When the provider's free limit is reached, the app tells the user to try again in a minute.

## Customize

- Personality and rules: edit `SYSTEM` in `server.js`.
- Colors, name, starter questions: edit `public/index.html`.
- Installed app name and theme color: `public/manifest.webmanifest`.
