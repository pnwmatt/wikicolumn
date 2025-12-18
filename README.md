# WikiColumn

A Firefox extension that lets you add columns from Wikidata to most datatables on Wikipedia. Once activated on a table, you choose which column is "key" (e.g. movie titles, business names), and then select which properties from Wikidata you want to add as new columns to the table. The extension fetches the data from Wikidata and inserts it to the table.

## Example Use Cases

- Add genre, run time, and review score to some [award winner tables](https://en.wikipedia.org/wiki/GLAAD_Media_Award_for_Outstanding_Film_%E2%80%93_Wide_Release)

- Add the `opposite` to the table of [zodiac signs](https://en.wikipedia.org/wiki/Chinese_zodiac)

- Add a link to the government website or coordinates from a [list of cities](https://en.wikipedia.org/wiki/List_of_cities_and_towns_in_Estonia)

- Add the `population` of [countries](https://en.wikipedia.org/wiki/European_Charter_for_Regional_or_Minority_Languages)

## Privacy Notes

- Does not communicate with any services except wikidata.org.

## Requirements

- Firefox 142.0 or later

# Contributions are Welcome

## Building

```bash
pnpm install
pnpm build
```

For development with file watching:

```bash
pnpm web-ext watch
```

## Loading the Extension

After building, load the extension from the `dist/` directory:

```bash
cd dist
pnpm web-ext run
```

To lint the extension:

```bash
cd dist
pnpm web-ext lint
```
