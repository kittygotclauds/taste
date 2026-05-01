# taste

**taste** is a no-build, static web app that aggregates recommended **restaurants, hotels, and shops** sourced **only** from **Goop** and **Vogue**, organized by major cities worldwide.

It intentionally **does not scrape** websites. Each listing is a manual entry with a backlink to the editorial source.

## Run it

- Run a tiny local server (recommended):

  - `npm run dev`

  Then visit `http://localhost:5173`.

- Or open `index.html` directly in a browser.

If your browser blocks module loading from `file://`, run any static server in the `taste/` folder (examples):

- **VS Code / Cursor**: “Live Server” extension
- **Node** (if installed): `npx serve`
- **Node (no deps)**: `node server.mjs`

Then visit `http://localhost:5173`.

## Edit / add cities & places

Update `taste/data.js`:

- Add entries to `PLACES`
- Keep `source` as `"goop"` or `"vogue"` only
- Set `sourceUrl` to the exact Goop/Vogue article URL you want to cite

## Data shape

Each place:

- `name` (string)
- `category` (`restaurant` | `hotel` | `shop`)
- `city`, `country` (string)
- `neighborhood` (optional string)
- `source` (`goop` | `vogue`)
- `sourceTitle`, `sourceUrl` (string)
- `tags` (optional array of strings)

