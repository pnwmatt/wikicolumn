# WikiColumn Development Guide

## Building the Extension

### Install Dependencies
```bash
pnpm install
```

### Build for Production
```bash
pnpm run build
```

This will compile all TypeScript files and copy static assets to the `dist/` directory.

### Watch Mode (Development)
```bash
pnpm run watch
```

This will watch for file changes and automatically rebuild.

### Clean Build
```bash
pnpm run clean
pnpm run build
```

## Loading the Extension in Firefox

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on"
4. Navigate to the `dist/` directory and select `manifest.json`

The extension will be loaded and the sidebar will automatically open.

## Project Structure

```
/firefox
├── src/                      # Source files
│   ├── lib/                  # Shared libraries
│   │   ├── types.ts          # TypeScript type definitions
│   │   ├── storage.ts        # browser.storage.local wrapper
│   ├── background/           # Background service worker
│   │   └── background.ts
│   ├── sidebar/              # Sidebar panel
│   │   ├── sidebar.html
│   │   ├── sidebar.ts
│   │   └── sidebar.css
│   ├── content/              # Content scripts
│   │   ├── content.ts
│   │   └── content.css
│   └── options/              # Settings page
│       ├── options.html
│       ├── options.ts
│       └── options.css
├── dist/                     # Build output (gitignored)
├── manifest.json             # Extension manifest
├── package.json
├── tsconfig.json
└── esbuild.config.js
```

## Development Workflow

1. Make changes to source files in `src/`
2. Build outputs to `dist/` via `pnpm run build` or `pnpm run watch`
3. Reload the extension in Firefox:
   - Go to `about:debugging`
   - Click "Reload" on the WikiColumn extension
4. Test changes in the browser
