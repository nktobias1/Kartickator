# Kartickator

Mobile-friendly PWA shell for an offline-first Kill Team card browser.

The app is designed to host only code and app assets. Official PDFs, extracted
cards, rule text, and official artwork are not committed or hosted by this
project.

## Workflow

The deployed app loads a static manifest of official Kill Team team-rule PDF
links. Open the official PDF for a team, save it on the device, then import it
into Kartickator. The app cuts the PDF into local card images, categorizes them
as faction rules, strategic ploys, firefight ploys, operatives, and equipment,
and stores the generated cards in the browser's IndexedDB for offline use.
If the saved official PDF keeps its original filename, the library-wide import
button matches it back to the manifest team automatically.
The landing screen shows the kill team library only. Favorite teams appear first,
then the remaining teams alphabetically, and selecting a team opens its card
preview page. Card previews show one card at a time with swipe navigation and a
compact fixed section switcher.

The official Warhammer Community download API is read only by GitHub Actions
when refreshing the manifest. The browser app stays static because official PDF
asset responses cannot be read directly from GitHub Pages by `fetch` due to CORS.

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
Actions. The Vite base path is configured for `/Kartickator/`.
