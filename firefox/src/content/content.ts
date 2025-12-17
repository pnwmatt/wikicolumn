/**
 * WikiColumn - Content Script
 *
 * This content script runs on all pages and handles:
 * 1. Scanning for HTML tables that can be enhanced with Wikidata columns
 * 2. Adding visual indicators (key column emoji, hamburger menu) to tables
 * 3. Extracting table data for the sidebar
 * 4. Injecting/removing Wikidata columns into tables
 * 5. Auto-restoring previously saved columns on page load
 *
 * ## Function Call Graph
 *
 * init()
 * ├── scanTables()
 * │   └── processTable()
 * │       ├── findKeyColumn()
 * │       │   └── columnHasWikipediaLinks()
 * │       ├── addKeyIndicator()
 * │       │   └── getHeaderRow()
 * │       └── addHamburgerMenu()
 * │           ├── getHeaderRow()
 * │           └── openSidebarWithTable()
 * │               └── extractTableData()
 * │                   ├── getHeaderRow()
 * │                   ├── getDataRows()
 * │                   ├── extractCellData()
 * │                   └── findNearestHeading()
 * └── reinjectSavedColumns()
 *     ├── getHeaderRow()
 *     ├── getDataRows()
 *     ├── getCachedEntitiesByLabel()
 *     ├── getCachedEntityData()
 *     ├── parseClaims()
 *     ├── getCachedPropertyInfo()
 *     ├── getClaimDisplayValues()
 *     └── injectColumn()
 *
 * Message handlers:
 * - CONTEXT_MENU_ACTIVATED → extractTableData()
 * - INJECT_COLUMNS → injectColumn()
 * - REMOVE_COLUMN → removeColumn()
 * - UPDATE_INSTANCE_OF → updateKeyColumnWithInstanceOf()
 * - HIGHLIGHT_NOT_FOUND_ON → highlightUnmatchedCells()
 * - HIGHLIGHT_NOT_FOUND_OFF → removeHighlights()
 * - GET_ELIGIBLE_TABLES → getEligibleTables()
 * - EXTRACT_TABLE → extractTableData()
 * - SCROLL_TO_TABLE → scrollIntoView()
 *
 * @module content
 */

import type {
  Message,
  TableData,
  CellData,
  LinkData,
  InjectColumnsPayload,
  RemoveColumnPayload,
  UpdateInstanceOfPayload,
  Claim,
  EligibleTableInfo,
} from '../lib/types';
import { getXPath, getNodeFromXPath } from '../lib/utils';
import { db } from '../lib/database';
import {
  getCachedEntitiesByLabel,
  getCachedEntityData,
  getCachedPropertyInfo,
  parseClaims,
  getClaimDisplayValues,
} from '../lib/wikidata';
import { PRIMARY_LANGUAGE } from '../lib/types';

// ============================================================================
// Module State
// ============================================================================

/** Tables that have been processed (prevents duplicate processing) */
const processedTables = new WeakSet<HTMLTableElement>();

/** Map of table xpath -> array of injected property IDs (for cleanup) */
const injectedColumnsByTable = new Map<string, string[]>();

/** Reference to the table where the hamburger menu was clicked */
let activeTable: HTMLTableElement | null = null;

/** Reference to the element that was right-clicked (for context menu) */
let lastRightClickedElement: Element | null = null;

// Listen for right-click to capture the target element
document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as Element;
  console.log('WikiColumn: Right-clicked on element:', lastRightClickedElement);
});

/** Logging verbosity (0 = errors only, 5 = verbose) */
const LOG_LEVEL = 5;

// ============================================================================
// URL Helper Functions
// ============================================================================

/**
 * Checks if a URL points to Wikipedia.
 *
 * @param url - The URL to check (can be relative or absolute)
 * @returns True if the URL is a Wikipedia link
 *
 * @example
 * isWikipediaUrl('/wiki/Paris') // true (relative)
 * isWikipediaUrl('https://en.wikipedia.org/wiki/Paris') // true
 * isWikipediaUrl('https://example.com') // false
 */
function isWikipediaUrl(url: string): boolean {
  try {
    const urlObj = new URL(url, window.location.href);
    return urlObj.hostname.endsWith('wikipedia.org');
  } catch {
    return false;
  }
}

/**
 * Extracts the Wikipedia article title from a Wikipedia URL.
 *
 * @param url - A Wikipedia URL (relative or absolute)
 * @returns The decoded article title, or null if not a valid Wikipedia URL
 *
 * @example
 * extractWikipediaTitle('https://en.wikipedia.org/wiki/Paris') // 'Paris'
 * extractWikipediaTitle('/wiki/Albert_Einstein') // 'Albert Einstein'
 * extractWikipediaTitle('https://example.com') // null
 */
function extractWikipediaTitle(url: string): string | null {
  try {
    const urlObj = new URL(url, window.location.href);
    if (!urlObj.hostname.endsWith('wikipedia.org')) {
      return null;
    }
    const pathMatch = urlObj.pathname.match(/^\/wiki\/(.+)$/);
    if (!pathMatch) return null;
    if (LOG_LEVEL > 2) console.log("WikiColumn: extractWikipediaTitle:", url, "->", decodeURIComponent(pathMatch[1]));
    return decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
}

// ============================================================================
// DOM Navigation Functions
// ============================================================================

/**
 * Finds the nearest heading element (h1-h5) before a table.
 * Used to determine the table's title when no caption is present.
 *
 * @param table - The table element to find a heading for
 * @returns The heading text, or empty string if none found
 *
 * @remarks
 * Searches backwards through siblings and up through parents.
 * Checks both direct heading elements and headings nested within containers.
 */
function findNearestHeading(table: HTMLTableElement): string {
  let element: Element | null = table;

  while (element) {
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (/^H[1-5]$/i.test(sibling.tagName)) {
        return sibling.textContent?.trim() || '';
      }
      const heading = sibling.querySelector('h1, h2, h3, h4, h5');
      if (heading) {
        return heading.textContent?.trim() || '';
      }
      sibling = sibling.previousElementSibling;
    }
    element = element.parentElement;
  }

  return '';
}

// ============================================================================
// Cell/Row Extraction Functions
// ============================================================================

/**
 * Extracts structured data from a table cell.
 *
 * @param cell - The table cell element to extract data from
 * @returns CellData containing text, HTML, and link information
 *
 * @remarks
 * For each anchor link in the cell, determines if it's a Wikipedia link
 * and extracts the article title if so. This is used for Wikidata matching.
 *
 * @sideEffects None (pure function)
 */
function extractCellData(cell: HTMLTableCellElement): CellData {
  const links: LinkData[] = [];

  const anchors = cell.querySelectorAll('a[href]');
  anchors.forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const fullHref = new URL(href, window.location.href).href;
    const isWikipedia = isWikipediaUrl(fullHref);

    links.push({
      href: fullHref,
      text: anchor.textContent?.trim() || '',
      isWikipedia,
      wikipediaTitle: isWikipedia ? extractWikipediaTitle(fullHref) || undefined : undefined,
    });
  });

  return {
    text: cell.textContent?.trim() || '',
    html: cell.innerHTML,
    links,
  };
}

/**
 * Gets all data rows from a table, excluding the header row.
 *
 * @param table - The table element
 * @returns Array of data row elements (excludes header row)
 *
 * @remarks
 * Handles both tables with explicit <thead> and tables where
 * the first <tr> is the header row.
 */
function getDataRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = [];
  const thead = table.querySelector('thead');
  const headerRow = thead ? thead.querySelector('tr') : table.querySelector('tr');
  const tbody = table.querySelector('tbody') || table;
  const allRows = tbody.querySelectorAll('tr');

  allRows.forEach((row, index) => {
    // Skip header row if in tbody
    if (!thead && index === 0 && row === headerRow) {
      return;
    }
    rows.push(row as HTMLTableRowElement);
  });

  return rows;
}

/**
 * Gets the header row from a table.
 *
 * @param table - The table element
 * @returns The header row element, or null if not found
 *
 * @remarks
 * Prefers <thead><tr> if available, otherwise uses first <tr>.
 */
function getHeaderRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const thead = table.querySelector('thead');
  return (thead ? thead.querySelector('tr') : table.querySelector('tr')) as HTMLTableRowElement | null;
}

// ============================================================================
// Key Column Detection Functions
// ============================================================================

/**
 * Checks if a column contains Wikipedia links in the first N rows.
 *
 * @param table - The table element
 * @param colIndex - Zero-based column index to check
 * @param maxRows - Maximum number of rows to check (default: 5)
 * @returns True if at least one cell in the column has a Wikipedia link
 *
 * @remarks
 * Used to identify which column should be the "key column" for Wikidata matching.
 * Only checks the first few rows for performance.
 */
function columnHasWikipediaLinks(table: HTMLTableElement, colIndex: number, maxRows: number = 5): boolean {
  const dataRows = getDataRows(table);
  const rowsToCheck = Math.min(dataRows.length, maxRows);

  for (let i = 0; i < rowsToCheck; i++) {
    const cells = dataRows[i].querySelectorAll('td, th');
    const cell = cells[colIndex] as HTMLTableCellElement | undefined;
    if (cell) {
      const anchors = Array.from(cell.querySelectorAll('a[href]'));
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        try {
          const fullHref = new URL(href, window.location.href).href;
          if (isWikipediaUrl(fullHref)) {
            return true;
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  return false;
}

/**
 * Finds the leftmost column that contains Wikipedia links.
 * This column becomes the "key column" for Wikidata matching.
 *
 * @param table - The table element
 * @returns Zero-based column index, or -1 if no Wikipedia links found
 *
 * @remarks
 * - Skips center-aligned columns (typically numeric data)
 * - Returns the leftmost column with Wikipedia links
 * - Used to determine which column values to match against Wikidata
 *
 * @calls columnHasWikipediaLinks
 */
function findKeyColumn(table: HTMLTableElement): number {
  const headerRow = getHeaderRow(table);
  if (!headerRow) return -1;

  const numCols = headerRow.querySelectorAll('td').length;

  for (let colIndex = 0; colIndex < numCols; colIndex++) {
    // if the column is center aligned, skip it (likely not a key column)
    const headerCells = headerRow.querySelectorAll('td');
    const headerCell = headerCells[colIndex] as HTMLTableCellElement | undefined;
    if (headerCell) {
      const textAlign = window.getComputedStyle(headerCell).textAlign;
      if (textAlign === 'center') {
        if (LOG_LEVEL > 2) console.log("WikiColumn: findKeyColumn: skipping center-aligned column", colIndex);
        continue;
      }
    }
    if (columnHasWikipediaLinks(table, colIndex)) {

      console.log("WikiColumn: findKeyColumn: found key column at index", colIndex);
      return colIndex;
    }
  }
  console.log("WikiColumn: findKeyColumn: no key column found");
  return -1;
}

// ============================================================================
// Table UI Enhancement Functions
// ============================================================================

/**
 * Adds a 🔑 emoji indicator to the key column header.
 *
 * @param table - The table element
 * @param colIndex - Zero-based index of the key column
 *
 * @sideEffects
 * - Modifies the DOM by appending a span element to the header cell
 * - Only adds if not already present (idempotent)
 */
function addKeyIndicator(table: HTMLTableElement, colIndex: number): void {
  const headerRow = getHeaderRow(table);
  if (!headerRow) return;

  const headerCells = headerRow.querySelectorAll('td');
  const headerCell = headerCells[colIndex] as HTMLTableCellElement | undefined;

  console.log("WikiColumn: addKeyIndicator: adding key indicator to column", colIndex);

  if (headerCell && !headerCell.querySelector('.wikicolumn-key-indicator')) {
    const keySpan = document.createElement('span');
    keySpan.className = 'wikicolumn-key-indicator';
    keySpan.textContent = ' 🔑';
    keySpan.title = 'WikiColumn key column (has Wikipedia links)';
    headerCell.appendChild(keySpan);
  }
}

/**
 * Adds a hamburger menu button (☰) to the table's header row.
 * Clicking the button opens the sidebar with this table selected.
 *
 * @param table - The table element
 *
 * @sideEffects
 * - Modifies the DOM by adding a button to the last header cell
 * - Sets up a click event listener that opens the sidebar
 * - Only adds if not already present (idempotent)
 */
function addHamburgerMenu(table: HTMLTableElement): void {
  const headerRow = getHeaderRow(table);
  if (!headerRow) return;

  const headerCells = headerRow.querySelectorAll('th, td');
  const lastCell = headerCells[headerCells.length - 1] as HTMLTableCellElement | undefined;

  if (lastCell && !lastCell.querySelector('.wikicolumn-menu-btn')) {
    // Make the cell position relative for absolute positioning of menu
    const currentPosition = window.getComputedStyle(lastCell).position;
    if (currentPosition === 'static') {
      lastCell.style.position = 'relative';
    }

    // Add a wrapper span for the hamburger to prevent layout shift
    const menuWrapper = document.createElement('span');
    menuWrapper.className = 'wikicolumn-menu-wrapper';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'wikicolumn-menu-btn';
    menuBtn.innerHTML = '☰';
    menuBtn.title = 'Edit table with WikiColumn';
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeTable = table;
      openSidebarWithTable(table);
    });

    menuWrapper.appendChild(menuBtn);
    lastCell.appendChild(menuWrapper);
  }
}

// ============================================================================
// Table Data Extraction Functions
// ============================================================================

/**
 * Extracts complete structured data from a table element.
 *
 * @param table - The table element to extract data from
 * @returns TableData object containing headers, rows, xpath, and title
 *
 * @remarks
 * This is the main function for converting an HTML table into
 * a structured format that can be sent to the sidebar.
 *
 * @calls getHeaderRow, getDataRows, extractCellData, getXPath, findNearestHeading
 */
function extractTableData(table: HTMLTableElement): TableData {
  const headers: CellData[] = [];
  const rows: CellData[][] = [];

  const headerRow = getHeaderRow(table);
  if (headerRow) {
    const headerCells = headerRow.querySelectorAll('th, td');
    headerCells.forEach((cell) => {
      headers.push(extractCellData(cell as HTMLTableCellElement));
    });
  }

  const dataRows = getDataRows(table);
  dataRows.forEach((row) => {
    const rowData: CellData[] = [];
    const cells = row.querySelectorAll('td');
    cells.forEach((cell) => {
      rowData.push(extractCellData(cell as HTMLTableCellElement));
    });
    if (rowData.length > 0) {
      rows.push(rowData);
    }
  });

  const xpath = getXPath(table);

  const tableCaption = table.querySelector('caption');
  let tableTitle = '';
  if (!tableCaption || tableCaption.textContent?.trim() === '') {
    tableTitle = findNearestHeading(table);
  } else {
    tableTitle = tableCaption.textContent?.trim() || '';
  }

  return {
    headers,
    rows,
    xpath,
    tableTitle,
  };
}

/**
 * Opens the sidebar and sends table data to it.
 *
 * @param table - The table element to edit
 *
 * @sideEffects
 * - Sends EDIT_TABLE message to the extension runtime
 * - Waits 150ms for sidebar to be ready
 *
 * @calls extractTableData
 */
async function openSidebarWithTable(table: HTMLTableElement): Promise<void> {
  console.log("WikiColumn: Opening sidebar with table", table);

  // Small delay to ensure sidebar is ready (if it opened)
  await new Promise((resolve) => setTimeout(resolve, 150));

  const tableData = extractTableData(table);


  // Send table data to sidebar - this will work if sidebar is open
  await browser.runtime.sendMessage({
    type: 'EDIT_TABLE',
    payload: {
      tableData,
      url: window.location.href,
    },
  });
}

// ============================================================================
// Table Scanning Functions
// ============================================================================

/**
 * Processes a single table, adding WikiColumn enhancements if eligible.
 *
 * @param table - The table element to process
 *
 * @preconditions
 * - Table must have a header row (thead or th elements)
 *
 * @sideEffects
 * - Adds key indicator emoji to key column
 * - Adds hamburger menu to header row
 * - Adds 'wikicolumn-enabled' class to table
 * - Adds table to processedTables WeakSet
 *
 * @remarks
 * Called once per table (uses WeakSet to prevent duplicates).
 * Skips tables without headers or Wikipedia links.
 *
 * @calls findKeyColumn, addKeyIndicator, addHamburgerMenu
 */
function processTable(table: HTMLTableElement): void {
  if (processedTables.has(table)) return;
  processedTables.add(table);

  console.log("WikiColumn: Found new table to process", table);

  // If the table doesn't have a non-nested thead or th, skip processing
  const hasThead = !!table.querySelector(':scope > thead, :scope > tbody > thead');
  const hasTh = !!table.querySelector(':scope > thead > th, :scope > th, :scope > tr > th, :scope > tbody > tr > th');
  if (LOG_LEVEL > 2) console.log("WikiColumn: Table hasThead =", hasThead, ", hasTh =", hasTh);
  if (!hasThead && !hasTh) {
    console.log("WikiColumn: Skipping table without header", table);
    return;
  }

  // Find key column
  const keyColIndex = findKeyColumn(table);

  if (keyColIndex >= 0) {
    // Add key indicator to header
    addKeyIndicator(table, keyColIndex);

    // Add hamburger menu to header row
    addHamburgerMenu(table);

    // Mark table as WikiColumn-enabled
    table.classList.add('wikicolumn-enabled');

    console.log(`WikiColumn: Found table with key column ${keyColIndex}`, table);
  }
}

/**
 * Scans all tables on the page and processes eligible ones.
 *
 * @sideEffects
 * - Processes all table elements in the document
 *
 * @calls processTable
 */
function scanTables(): void {
  if (LOG_LEVEL > 1) console.log("WikiColumn: Scanning page for all tables");
  const tables = document.querySelectorAll('table');
  tables.forEach((table) => {
    processTable(table as HTMLTableElement);
  });
}

// ============================================================================
// Column Injection/Removal Functions
// ============================================================================

/**
 * Injects a new column into a table after a specific column index.
 *
 * @param table - The table element
 * @param headerHtml - HTML content for the new header cell
 * @param values - Array of values for each data row
 * @param propertyId - Wikidata property ID (e.g., 'P31')
 * @param afterColumnIndex - Insert after this column (0-based index)
 *
 * @sideEffects
 * - Adds new <th> to header row with 'wikicolumn-added-column' class
 * - Adds new <td> to each data row with 'wikicolumn-added-column' class
 * - Updates injectedColumnsByTable map for cleanup tracking
 *
 * @remarks
 * Cells are marked with data-wikicolumn-property attribute for later removal.
 *
 * @calls getHeaderRow, getDataRows, getXPath
 */
function injectColumn(
  table: HTMLTableElement,
  headerHtml: string,
  values: string[],
  propertyId: string,
  afterColumnIndex: number
): void {
  const xpath = getXPath(table);
  console.log("WikiColumn: injectColumn: injecting column", propertyId, "after column", afterColumnIndex, "into table", xpath);

  const existing = injectedColumnsByTable.get(xpath) || [];
  existing.push(propertyId);
  injectedColumnsByTable.set(xpath, existing);

  const headerRow = getHeaderRow(table);
  if (headerRow) {
    const th = document.createElement('th');
    th.innerHTML = headerHtml;
    th.setAttribute('data-wikicolumn-property', propertyId);
    th.classList.add('wikicolumn-added-column');

    // Insert after the specified column (afterColumnIndex + 1 is the reference node)
    const headerCells = headerRow.querySelectorAll('th, td');
    const refCell = headerCells[afterColumnIndex + 1];
    if (refCell) {
      headerRow.insertBefore(th, refCell);
    } else {
      headerRow.appendChild(th);
    }
  }

  const dataRows = getDataRows(table);
  dataRows.forEach((row, index) => {
    const td = document.createElement('td');
    td.textContent = values[index] || '';
    td.setAttribute('data-wikicolumn-property', propertyId);
    td.classList.add('wikicolumn-added-column');

    // Insert after the specified column
    const cells = row.querySelectorAll('td, th');
    const refCell = cells[afterColumnIndex + 1];
    if (refCell) {
      row.insertBefore(td, refCell);
    } else {
      row.appendChild(td);
    }
  });
}

/**
 * Removes a previously injected column from a table.
 *
 * @param table - The table element
 * @param propertyId - The Wikidata property ID of the column to remove
 *
 * @sideEffects
 * - Removes all cells with matching data-wikicolumn-property attribute
 * - Updates injectedColumnsByTable map
 *
 * @calls getXPath
 */
function removeColumn(table: HTMLTableElement, propertyId: string): void {
  const cells = table.querySelectorAll(`[data-wikicolumn-property="${propertyId}"]`);
  cells.forEach((cell) => cell.remove());

  const xpath = getXPath(table);
  const existing = injectedColumnsByTable.get(xpath) || [];
  const filtered = existing.filter((id) => id !== propertyId);
  injectedColumnsByTable.set(xpath, filtered);
}

/**
 * Adds instance-of (P31) labels to key column cells.
 *
 * @param table - The table element
 * @param keyColIndex - Index of the key column
 * @param instanceOfData - Map of row index to instance-of label string
 *
 * @sideEffects
 * - Appends span elements with 'wikicolumn-instance-of' class to key column cells
 * - Only adds if not already present (idempotent)
 *
 * @calls getDataRows
 */
function updateKeyColumnWithInstanceOf(
  table: HTMLTableElement,
  keyColIndex: number,
  instanceOfData: Map<number, string>
): void {
  const dataRows = getDataRows(table);

  dataRows.forEach((row, rowIndex) => {
    const cells = row.querySelectorAll('td, th');
    const cell = cells[keyColIndex] as HTMLTableCellElement | undefined;

    if (cell && instanceOfData.has(rowIndex)) {
      const instanceOf = instanceOfData.get(rowIndex)!;

      // Check if we already added instance of
      if (!cell.querySelector('.wikicolumn-instance-of')) {
        const instanceSpan = document.createElement('span');
        instanceSpan.className = 'wikicolumn-instance-of';
        instanceSpan.textContent = ` (${instanceOf})`;
        cell.appendChild(instanceSpan);
      }
    }
  });
}

// ============================================================================
// Row Highlighting Functions
// ============================================================================

/**
 * Highlights rows based on whether they matched a Wikidata entity.
 *
 * @param table - The table element
 * @param labels - Array of unmatched label strings
 * @param keyColumnIndex - Index of the key column
 *
 * @sideEffects
 * - Adds 'wikicolumn-unmatched-row' class to rows that match unmatched labels
 * - Adds 'wikicolumn-matched-row' class to rows that don't match
 *
 * @remarks
 * Uses case-insensitive substring matching to determine if a row's
 * key column text matches any of the unmatched labels.
 *
 * @calls getDataRows
 */
function highlightUnmatchedCells(table: HTMLTableElement, labels: string[], keyColumnIndex: number): void {
  const dataRows = getDataRows(table);

  console.log("WikiColumn: highlightUnmatchedCells: highlighting unmatched cells in column", keyColumnIndex, "with labels:", labels);

  dataRows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    const keyCell = cells[keyColumnIndex] as HTMLTableCellElement | undefined;

    if (!keyCell) return;

    const cellText = keyCell.textContent?.toLowerCase() || '';

    // Check if this key cell's text matches any unmatched label
    const isUnmatched = labels.some((label) =>
      cellText.includes(label.toLowerCase())
    );

    if (isUnmatched) {
      (keyCell.parentNode as HTMLElement)?.classList.add('wikicolumn-unmatched-row');
    } else {
      (keyCell.parentNode as HTMLElement)?.classList.add('wikicolumn-matched-row');
    }
  });
}

/**
 * Removes row highlighting from a table.
 *
 * @param table - The table element
 *
 * @sideEffects
 * - Removes 'wikicolumn-unmatched-row' and 'wikicolumn-matched-row' classes
 */
function removeHighlights(table: HTMLTableElement): void {
  const highlightedCells = table.querySelectorAll('.wikicolumn-unmatched-row, .wikicolumn-matched-row');
  highlightedCells.forEach((cell) => {
    cell.classList.remove('wikicolumn-unmatched-row');
    cell.classList.remove('wikicolumn-matched-row');
  });
}

// ============================================================================
// Auto-Restore Functions
// ============================================================================

/**
 * Restores previously saved Wikidata columns on page load.
 *
 * @preconditions
 * - Database must be initialized before calling
 *
 * @sideEffects
 * - Reads from IndexedDB (tables, label cache, entity cache)
 * - Writes to IndexedDB (claims)
 * - Modifies DOM by injecting columns
 *
 * @remarks
 * For each saved table:
 * 1. Find the table by xpath
 * 2. Verify key column header still matches (case-insensitive)
 * 3. Re-match rows to Wikidata using cached SPARQL results
 * 4. Fetch entity data and parse claims
 * 5. Inject saved columns with current values
 *
 * @calls
 * - db.init, db.getTablesByUrl, db.saveClaims, db.getClaimsByQids
 * - getHeaderRow, getDataRows, injectColumn
 * - getCachedEntitiesByLabel, getCachedEntityData, getCachedPropertyInfo
 * - parseClaims, getClaimDisplayValues
 */
async function reinjectSavedColumns(): Promise<void> {
  try {
    await db.init();
    const url = window.location.href;
    const savedTables = await db.getTablesByUrl(url);

    for (const tableRecord of savedTables) {
      if (tableRecord.addedColumns.length === 0) continue;

      const tableElement = getNodeFromXPath(tableRecord.xpath, document) as HTMLTableElement;
      if (!tableElement || tableElement.tagName !== 'TABLE') {
        console.log('WikiColumn: Table not found for xpath:', tableRecord.xpath);
        continue;
      }

      // Verify key column header still matches (case-insensitive)
      const headerRow = getHeaderRow(tableElement);
      if (!headerRow) {
        console.log('WikiColumn: No header row found for table:', tableRecord.id);
        continue;
      }

      const headerCells = headerRow.querySelectorAll('th, td');
      const keyColumnHeader = headerCells[tableRecord.keyColumnIndex] as HTMLTableCellElement | undefined;
      const savedKeyHeader = tableRecord.originalColumns[tableRecord.keyColumnIndex]?.header || '';
      const currentKeyHeader = keyColumnHeader?.textContent?.trim() || '';

      if (currentKeyHeader.toLowerCase() !== savedKeyHeader.toLowerCase()) {
        console.log('WikiColumn: Key column header mismatch. Expected:', savedKeyHeader, 'Got:', currentKeyHeader);
        continue;
      }

      console.log('WikiColumn: Restoring saved table with', tableRecord.addedColumns.length, 'added columns:', tableRecord.id);

      // Extract labels from key column
      const dataRows = getDataRows(tableElement);
      const labels: string[] = [];
      const rowToLabel = new Map<number, string>();

      dataRows.forEach((row, rowIndex) => {
        const cells = row.querySelectorAll('td, th');
        const keyCell = cells[tableRecord.keyColumnIndex] as HTMLTableCellElement | undefined;
        if (keyCell && keyCell.textContent?.trim()) {
          const label = keyCell.textContent.replace(/^\d+\.\s*/, '').replace(/(‡|§)$/, '').trim();
          labels.push(label);
          rowToLabel.set(rowIndex, label);
        }
      });

      // Match rows to Wikidata using cached data
      const labelToQidMap = await getCachedEntitiesByLabel(labels, PRIMARY_LANGUAGE);

      // Build row matches (pick first QID for each label)
      const rowMatches: { rowIndex: number; qid: string | null }[] = dataRows.map((_, rowIndex) => {
        const label = rowToLabel.get(rowIndex);
        const strippedLabel = label ? label.replace(/^\d+\.\s*/, '').replace(/‡$/, '').trim() : label;
        const qidMap = strippedLabel ? labelToQidMap.get(strippedLabel) : undefined;

        let qid: string | null = null;
        if (qidMap && qidMap.size > 0) {
          const firstEntry = qidMap.entries().next().value;
          if (firstEntry) {
            qid = firstEntry[0];
          }
        }

        return { rowIndex, qid };
      });

      // Fetch entity data for matched QIDs
      const qids = rowMatches.filter((m) => m.qid).map((m) => m.qid!);
      if (qids.length === 0) {
        console.log('WikiColumn: No QIDs matched for table:', tableRecord.id);
        continue;
      }

      const entityData = await getCachedEntityData(qids, PRIMARY_LANGUAGE);

      // Parse claims
      const allClaims: Claim[] = [];
      const allPropertyIds = new Set<string>();

      for (const item of entityData.values()) {
        const claims = parseClaims(item.json);
        allClaims.push(...claims);
        claims.forEach((claim) => allPropertyIds.add(claim.pid));
      }

      await db.saveClaims(allClaims);

      // Fetch property info (to ensure cache is populated)
      await getCachedPropertyInfo(Array.from(allPropertyIds), PRIMARY_LANGUAGE);

      // Get claims by QID
      const claimsByQid = await db.getClaimsByQids(qids);

      // Re-inject each added column
      for (const addedColumn of tableRecord.addedColumns) {
        // Filter claims for this property
        const relevantClaims: Claim[] = [];
        for (const [, claims] of claimsByQid) {
          const claim = claims.find((c) => c.pid === addedColumn.propertyId);
          if (claim) {
            relevantClaims.push(claim);
          }
        }

        // Get display values
        const displayValues = await getClaimDisplayValues(relevantClaims, PRIMARY_LANGUAGE);

        // Build values array
        const values: string[] = [];
        for (const match of rowMatches) {
          if (match.qid) {
            const qidValues = displayValues.get(match.qid);
            const value = qidValues?.get(addedColumn.propertyId) || '';
            values.push(value || '🤔');
          } else {
            values.push('🤔');
          }
        }

        // Create header HTML
        const originalHeader = tableRecord.originalColumns[0];
        const headerHtml = originalHeader
          ? originalHeader.headerHtml.replace(
              new RegExp(escapeRegExp(originalHeader.header), 'g'),
              addedColumn.label
            )
          : addedColumn.label;

        // Inject the column
        injectColumn(tableElement, headerHtml, values, addedColumn.propertyId, tableRecord.keyColumnIndex);
      }

      console.log('WikiColumn: Successfully restored', tableRecord.addedColumns.length, 'columns for table:', tableRecord.id);
    }
  } catch (error) {
    console.error('WikiColumn: Error re-injecting saved columns:', error);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Escapes special characters in a string for use in RegExp.
 *
 * @param string - The string to escape
 * @returns String with special regex characters escaped
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Table Picker Functions
// ============================================================================

/**
 * Gets all eligible tables on the page for the Table Picker UI.
 *
 * @returns Array of EligibleTableInfo objects
 *
 * @remarks
 * Eligibility criteria:
 * - Must have a header row (thead or th elements)
 * - Must have at least 1 data row
 * - Must be visible (not display:none or visibility:hidden)
 *
 * @calls getHeaderRow, getDataRows, findKeyColumn, findNearestHeading, getXPath
 */
function getEligibleTables(): EligibleTableInfo[] {
  const tables = document.querySelectorAll('table');
  const eligible: EligibleTableInfo[] = [];

  tables.forEach((table) => {
    const tableEl = table as HTMLTableElement;

    // Check if table is visible
    const style = window.getComputedStyle(tableEl);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return;
    }

    // Check for header row
    const hasThead = !!tableEl.querySelector(':scope > thead, :scope > tbody > thead');
    const hasTh = !!tableEl.querySelector(':scope > thead > tr > th, :scope > tr > th, :scope > tbody > tr > th');

    if (!hasThead && !hasTh) {
      return;
    }

    // Get header row and data rows
    const headerRow = getHeaderRow(tableEl);
    const dataRows = getDataRows(tableEl);

    // Must have at least 1 data row
    if (dataRows.length === 0) {
      return;
    }

    // Get column count from header
    const columnCount = headerRow ? headerRow.querySelectorAll('th, td').length : 0;

    // Check if any column has Wikipedia links
    const hasWikipediaLinks = findKeyColumn(tableEl) >= 0;

    // Get table title
    const tableCaption = tableEl.querySelector('caption');
    let title = '';
    if (tableCaption && tableCaption.textContent?.trim()) {
      title = tableCaption.textContent.trim();
    } else {
      title = findNearestHeading(tableEl) || 'Untitled Table';
    }

    eligible.push({
      xpath: getXPath(tableEl),
      title,
      rowCount: dataRows.length,
      columnCount,
      hasWikipediaLinks,
    });
  });

  return eligible;
}

// Listen for messages from background script
browser.runtime.onMessage.addListener(
  async (message: Message, _sender, sendResponse) => {
    switch (message.type) {
      case 'CONTEXT_MENU_ACTIVATED': {
        // Background script opened the sidebar and is telling us to extract the table
        const payload = message.payload as { url: string };
        let table: HTMLTableElement | null = null;

        // Use the element captured by our contextmenu listener
        if (lastRightClickedElement) {
          table = lastRightClickedElement.closest('table');
          console.log('WikiColumn: Found table from lastRightClickedElement:', table);
        }

        // Fall back to activeTable (hamburger menu click)
        if (!table && activeTable) {
          table = activeTable;
          console.log('WikiColumn: Using activeTable:', table);
        }

        console.log("WikiColumn: Received CONTEXT_MENU_ACTIVATED. table =", table);

        if (table) {
          const tableData = extractTableData(table!);

          // Send table data directly to sidebar
          browser.runtime.sendMessage({
            type: 'EDIT_TABLE',
            payload: {
              tableData,
              url: payload.url || window.location.href,
            },
          });
          return true;
        } else {
          console.warn('WikiColumn: No table found at click location');
        }
        break;
      }

      case 'INJECT_COLUMNS': {
        console.log("WikiColumn: Received INJECT_COLUMNS message", message);
        const payload = message.payload as InjectColumnsPayload;
        const table = getNodeFromXPath(payload.xpath, document) as HTMLTableElement;
        if (table && table.tagName === 'TABLE') {
          for (const column of payload.columns) {
            injectColumn(table, column.headerHtml, column.values, column.propertyId, payload.afterColumnIndex);
          }
          sendResponse({ success: true });
        } else {
          sendResponse({ error: 'Table not found' });
        }
        break;
      }

      case 'REMOVE_COLUMN': {
        console.log("WikiColumn: Received REMOVE_COLUMN message", message);
        const removePayload = message.payload as RemoveColumnPayload;
        const removeTable = getNodeFromXPath(removePayload.xpath, document) as HTMLTableElement;
        if (removeTable && removeTable.tagName === 'TABLE') {
          removeColumn(removeTable, removePayload.propertyId);
          sendResponse({ success: true });
        } else {
          sendResponse({ error: 'Table not found' });
        }
        break;
      }

      case 'UPDATE_INSTANCE_OF': {
        return;
        console.log("WikiColumn: Received UPDATE_INSTANCE_OF message", message);
        const updatePayload = message.payload as UpdateInstanceOfPayload;
        const updateTable = getNodeFromXPath(updatePayload.xpath, document) as HTMLTableElement;
        if (updateTable && updateTable.tagName === 'TABLE') {
          const dataMap = new Map(Object.entries(updatePayload.instanceOfData).map(
            ([k, v]) => [parseInt(k, 10), v]
          ));
          updateKeyColumnWithInstanceOf(updateTable, updatePayload.keyColIndex, dataMap);
          sendResponse({ success: true });
        } else {
          sendResponse({ error: 'Table not found' });
        }
        break;
      }

      case 'HIGHLIGHT_NOT_FOUND_ON': {
        const payload = message.payload as { xpath: string; labels: string[]; keyColumnIndex: number };
        const table = getNodeFromXPath(payload.xpath, document) as HTMLTableElement;
        if (table && table.tagName === 'TABLE') {
          highlightUnmatchedCells(table, payload.labels, payload.keyColumnIndex);
        }
        break;
      }

      case 'HIGHLIGHT_NOT_FOUND_OFF': {
        const payload = message.payload as { xpath: string };
        const table = getNodeFromXPath(payload.xpath, document) as HTMLTableElement;
        if (table && table.tagName === 'TABLE') {
          removeHighlights(table);
        }
        break;
      }

      case 'GET_ELIGIBLE_TABLES': {
        const eligibleTables = getEligibleTables();
        console.log('WikiColumn: Found', eligibleTables.length, 'eligible tables');
        return Promise.resolve({
          tables: eligibleTables,
          url: window.location.href,
        });
      }

      case 'EXTRACT_TABLE': {
        const extractPayload = message.payload as { xpath: string };
        const table = getNodeFromXPath(extractPayload.xpath, document) as HTMLTableElement;
        if (table && table.tagName === 'TABLE') {
          const tableData = extractTableData(table);
          return Promise.resolve({
            tableData,
            url: window.location.href,
          });
        }
        return Promise.resolve({ error: 'Table not found' });
      }

      case 'SCROLL_TO_TABLE': {
        const scrollPayload = message.payload as { xpath: string };
        const table = getNodeFromXPath(scrollPayload.xpath, document) as HTMLTableElement;
        if (table && table.tagName === 'TABLE') {
          table.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Add a brief highlight effect
          table.style.outline = '3px solid #4a90d9';
          table.style.outlineOffset = '2px';
          setTimeout(() => {
            table.style.outline = '';
            table.style.outlineOffset = '';
          }, 2000);
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ error: 'Table not found' });
      }
    }

    return true;
  }
);

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the WikiColumn content script.
 *
 * @sideEffects
 * - Scans existing tables on the page
 * - Re-injects saved columns from IndexedDB
 * - Sets up MutationObserver to watch for new tables
 *
 * @calls scanTables, reinjectSavedColumns, processTable
 */
function init(): void {
  // Scan existing tables
  scanTables();

  // Re-inject saved columns
  reinjectSavedColumns();

  // Watch for dynamically added tables
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLTableElement) {
          processTable(node);
        } else if (node instanceof HTMLElement) {
          const tables = node.querySelectorAll('table');
          tables.forEach((table) => processTable(table as HTMLTableElement));
        }
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

console.log('WikiColumn content script loaded');
