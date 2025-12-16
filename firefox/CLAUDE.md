# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

All commands use **pnpm** (not npm):

```bash
pnpm install        # Install dependencies
pnpm run build      # Build extension to dist/
pnpm run watch      # Watch mode for development
pnpm run clean      # Remove dist/ directory
```

**Load in Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → select `dist/manifest.json`

## Tech Stack

- TypeScript 5.3.3 with strict mode (ES2020 target)
- esbuild 0.20.0 bundler
- Firefox Manifest V3 extension (requires Firefox 115+)

## Architecture

Firefox sidebar extension allows adding columns of Wikidata to tables on websites.

### Components

| Component | Entry Point | Role |
|-----------|-------------|------|
| Background | `src/background/background.ts` | Service worker, message hub, API coordination |
| Sidebar | `src/sidebar/sidebar.ts` | Table Editor UI |
| Content Script | `src/content/content.ts` | Table selection |
| Options | `src/options/options.ts` | Unused for now |

### Shared Libraries (`src/lib/`)

- `types.ts` - Core interfaces (Project, SavedPage, Annotation, StorageData)
- `storage.ts` - Typed wrapper for `browser.storage.local`
- `utils.ts` - XPath helpers, URL normalization, date formatting

### Message Protocol

Components communicate via `browser.runtime.sendMessage()` with these message types:
 - 'EDIT_TABLE' - Sent from content.ts when you rightclick on a table and select "Edit with WikiColumn".  Passes the table content and URL to sidebar.ts.
   - Received by sidebar.ts: loads the table editor for that table



### Editing a table
0. Set a constant variable that assumes the primary language is `en`
1. When the user activates WikiColumn on a page by right-clicking on a column of a <table> on a page, content.ts transfers the table data and which column to sidebar via the EDIT_TABLE message
2. The sidebar then lists the column headings vertically ennumerated as A,B,C etc similar to a spreadsheet
3. Insert the table into the IndexedDB tables(url, tableTitle, xpath using relative to h1/h2/h3/h4/h5, originalColumns, addedColumns)
3. A method is called to parse the rows and determine which column might be the key column for wikidata matching.  If a column contains a wikipedia link, then that is the chosen column.
4. Add an emoji `key` next to the column name (in the sidebar) that is the key column used for wikidata matching.
5. Query wikidata for each row in the key column to get the QID and store that in the browser's IndexedDB (table items(qid, json, label).  For each `claims` in the json, INSERT OR IGNORE into the properties table (property id, label, description, usage, visibility).  The `claims` table uses qid, pid, values (which is always an array of qids).  Query for only the label of each claim (using the primary language variable) and each claimed property's label.    
6. Show a button that allows users to "Add new column" which presents in an html5 component that shows:
  - For each row of the original table, get all the claims for that row and keep count of each property used across all rows.
  - Show a list of the property label (using the primary language), the % of rows with that property, an eye icon to 'hide' the row, and allow the user to select a property to add as a new column to the original table.
7. Using the local IndexedDB as the data source, add a new column to the original table in the order picked by the user in the sidebar.  Label the column with the property label using the same formatting as other column headers (take a column with a header, strip the html tags, then str_replace the old header text with the new property label of the column header with html).
8. The end result is we have added a new column of wikidata properties to the original table on the page.
9. Allow the user to drag-and-drop to reorder the columns in the sidebar.
10. For a wikidata column on the page, the user can drag-and-drop to reorder that column amongst the original columns.  The user can resize all the columns.

