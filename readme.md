# TRACE Browser Extension

## Install in Chrome (Developer Mode)

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this `trace-extension/` folder
5. The TRACE badge icon appears in your toolbar

## Build the TypeScript

```bash
npm install -D typescript @types/chrome
npx tsc
```

This compiles `src/background.ts` → `background.js` and `src/content.ts` → `content.js`

## How it works

- **Content script** scans every `<img>` tag on the page
- Computes a canvas fingerprint hash of each image
- Sends the hash to the **background service worker**
- Background queries `localhost:3001/v1/search?hash=...`
- Injects a color-coded badge overlay on each image:
  - 🟢 VERIFIED ORIGINAL
  - 🟡 MODIFIED
  - 🔴 UNVERIFIED
  - 🟣 AI GENERATED
  - ⚪ UNKNOWN

## Privacy

- Images are hashed client-side in the browser
- Only the hash string is sent to the API — never the raw image
- No browsing data is logged