# YGO Draft Simulator

Yu-Gi-Oh booster box draft simulator with real-time lobby system.

## Local dev

```bash
npm install
npm start
# → http://localhost:3000
```

## Deploy to Railway (free, takes 2 minutes)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "ygo draft sim"
   # create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_NAME/ygo-draft.git
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to [railway.app](https://railway.app) and sign in with GitHub
   - Click **New Project → Deploy from GitHub repo**
   - Select your repo — Railway auto-detects Node and deploys
   - Click **Settings → Networking → Generate Domain** to get a public URL

3. **Share the URL**
   - Anyone with the URL can open the app, create/join lobbies with the 6-letter code
   - Railway's free tier gives you 500 hours/month (more than enough for sessions)

## Project structure

```
server.js          ← Express + WebSocket server
cards.json         ← All set/card data (add sets here)
public/
  index.html       ← Full single-page frontend
  titlescreen.png  ← Splash screen image
package.json
railway.json       ← Railway deploy config
```

## Adding new sets to cards.json

Each set follows this shape — just append to the `"sets"` array:

```json
{
  "id": "SET_CODE",
  "name": "Full Set Name",
  "cards": [
    { "name": "Card Name", "rarity": "Ultra Rare" },
    { "name": "Another Card", "rarity": "Common" }
  ]
}
```

Rarities: `"Common"`, `"Rare"`, `"Super Rare"`, `"Ultra Rare"`, `"Secret Rare"`

Card names must match [YGOPRODECK](https://db.ygoprodeck.com) exactly for card images to load.
