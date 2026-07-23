# Killteamator

Mobile-friendly PWA shell for an offline-first Kill Team card browser.

The app is designed to host only code and app assets. Official PDFs, extracted
cards, rule text, and official artwork are not committed or hosted by this
project; downloads and processing should happen locally on each user's device.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## GitHub Pages

Pushes to `main` deploy the static PWA bundle from `dist` through GitHub
Actions. The Vite base path is configured for `/Killteamator/`.
