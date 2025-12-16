// WikiColumn - Content Script

import type {
  Message,
  TableData,
  CellData,
  LinkData,
  InjectColumnsPayload,
  RemoveColumnPayload,
  UpdateInstanceOfPayload,
} from '../lib/types';
import { getXPath, getNodeFromXPath } from '../lib/utils';
import { db } from '../lib/database';

// Track tables we've already processed
const processedTables = new WeakSet<HTMLTableElement>();

// Store reference to injected columns for cleanup
const injectedColumnsByTable = new Map<string, string[]>();

// Track which table the hamburger menu was clicked on
let activeTable: HTMLTableElement | null = null;

// Track the last right-clicked element (for context menu)
let lastRightClickedElement: Element | null = null;

// Listen for right-click to capture the target element
document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as Element;
  console.log('WikiColumn: Right-clicked on element:', lastRightClickedElement);
});

const LOG_LEVEL = 5;

/**
 * Check if a URL is a Wikipedia link
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
 * Extract Wikipedia article title from URL
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

/**
 * Find the nearest heading (h1-h5) before the table
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

/**
 * Extract cell data including text, HTML, and links
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
 * Get data rows from a table (excluding header)
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
 * Get header row from a table
 */
function getHeaderRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const thead = table.querySelector('thead');
  return (thead ? thead.querySelector('tr') : table.querySelector('tr')) as HTMLTableRowElement | null;
}

/**
 * Check if a column has Wikipedia links in first N rows
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
 * Find the leftmost column with Wikipedia links
 * Returns -1 if no column has Wikipedia links
 */
function findKeyColumn(table: HTMLTableElement): number {
  const headerRow = getHeaderRow(table);
  if (!headerRow) return -1;

  const numCols = headerRow.querySelectorAll('th, td').length;

  for (let colIndex = 0; colIndex < numCols; colIndex++) {
    if (columnHasWikipediaLinks(table, colIndex)) {

      console.log("WikiColumn: findKeyColumn: found key column at index", colIndex);
      return colIndex;
    }
  }
  console.log("WikiColumn: findKeyColumn: no key column found");
  return -1;
}

/**
 * Add key emoji to column header
 */
function addKeyIndicator(table: HTMLTableElement, colIndex: number): void {
  const headerRow = getHeaderRow(table);
  if (!headerRow) return;

  const headerCells = headerRow.querySelectorAll('th, td');
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
 * Add hamburger menu to the header row (rightmost cell)
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

/**
 * Extract table data from a table element
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
    const cells = row.querySelectorAll('td, th');
    cells.forEach((cell) => {
      rowData.push(extractCellData(cell as HTMLTableCellElement));
    });
    if (rowData.length > 0) {
      rows.push(rowData);
    }
  });

  const xpath = getXPath(table);
  const tableTitle = findNearestHeading(table);

  return {
    headers,
    rows,
    xpath,
    tableTitle,
  };
}

/**
 * Open sidebar and send table data
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

/**
 * Scan and process a single table
 */
function processTable(table: HTMLTableElement): void {
  if (processedTables.has(table)) return;
  processedTables.add(table);

  console.log("WikiColumn: Found new table to process", table);

  // If the table doesn't have a non-nested thead or th, skip processing
  const hasThead = !!table.querySelector(':scope > thead, :scope > tbody > thead');
  const hasTh = !!table.querySelector(':scope > thead > th, :scope > th, :scope > tr > th, :scope > tbody > tr > th');
  const hasClass = table.classList.contains('wikicolumn-enabled');
  if (LOG_LEVEL > 2) console.log("WikiColumn: Table hasThead =", hasThead, ", hasTh =", hasTh);
  if (!hasThead && !hasTh) {
    console.log("WikiColumn: Skipping table without header", table);
    return;
  }

  // Find key column (leftmost with Wikipedia links)
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
 * Scan all tables on the page
 */
function scanTables(): void {
  if (LOG_LEVEL > 1) console.log("WikiColumn: Scanning page for all tables");
  const tables = document.querySelectorAll('table');
  tables.forEach((table) => {
    processTable(table as HTMLTableElement);
  });
}

/**
 * Inject a column into a table
 */
function injectColumn(
  table: HTMLTableElement,
  headerHtml: string,
  values: string[],
  propertyId: string
): void {
  const xpath = getXPath(table);

  const existing = injectedColumnsByTable.get(xpath) || [];
  existing.push(propertyId);
  injectedColumnsByTable.set(xpath, existing);

  const headerRow = getHeaderRow(table);
  if (headerRow) {
    const th = document.createElement('th');
    th.innerHTML = headerHtml;
    th.setAttribute('data-wikicolumn-property', propertyId);
    th.classList.add('wikicolumn-added-column');
    headerRow.appendChild(th);
  }

  const dataRows = getDataRows(table);
  dataRows.forEach((row, index) => {
    const td = document.createElement('td');
    td.textContent = values[index] || '';
    td.setAttribute('data-wikicolumn-property', propertyId);
    td.classList.add('wikicolumn-added-column');
    row.appendChild(td);
  });
}

/**
 * Remove an injected column from a table
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
 * Update key column cells with instance of info
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

/**
 * Re-inject saved columns on page load
 */
async function reinjectSavedColumns(): Promise<void> {
  try {
    const url = window.location.href;
    const tables = await db.getTablesByUrl(url);

    for (const tableRecord of tables) {
      if (tableRecord.addedColumns.length === 0) continue;

      const tableElement = getNodeFromXPath(tableRecord.xpath, document) as HTMLTableElement;
      if (!tableElement || tableElement.tagName !== 'TABLE') continue;

      console.log('WikiColumn: Found saved table with added columns:', tableRecord.id);
    }
  } catch (error) {
    console.error('WikiColumn: Error re-injecting saved columns:', error);
  }
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
            injectColumn(table, column.headerHtml, column.values, column.propertyId);
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
    }

    return true;
  }
);

// Initialize: scan tables and observe for new ones
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

// Run initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

console.log('WikiColumn content script loaded');
