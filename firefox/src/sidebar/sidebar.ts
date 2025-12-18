// WikiColumn - Sidebar UI

import {
  PRIMARY_LANGUAGE,
  type Message,
  type EditTablePayload,
  type TableData,
  type TableRecord,
  type RowMatch,
  type PropertyStats,
  type SidebarColumn,
  type Claim,
  type InjectColumnsPayload,
  type EligibleTableInfo,
} from '../lib/types';
import { db } from '../lib/database';
import { generateId } from '../lib/utils';
import {
  getCachedEntitiesByLabel,
  getCachedEntityData,
  parseClaims,
  getCachedPropertyInfo,
  getClaimDisplayValues,
} from '../lib/wikidata';

const LOG_LEVEL = 0;

// DOM Elements
const tablePicker = document.getElementById('tablePicker')!;
const tablePickerStatus = document.getElementById('tablePickerStatus')!;
const tablePickerList = document.getElementById('tablePickerList')!;
const emptyState = document.getElementById('emptyState')!;
const loadingState = document.getElementById('loadingState')!;
const loadingMessage = document.getElementById('loadingMessage')!;
const tableEditor = document.getElementById('tableEditor')!;
const backToPickerBtn = document.getElementById('backToPickerBtn')!;
const tableTitle = document.getElementById('tableTitle')!;
const tableStats = document.getElementById('tableStats')!;
const columnsList = document.getElementById('columnsList')!;
const matchingSection = document.getElementById('matchingSection')!;
const matchingProgressFill = document.getElementById('matchingProgressFill')!;
const matchingProgressText = document.getElementById('matchingProgressText')!;
const matchingStatus = document.getElementById('matchingStatus')!;
const addColumnBtn = document.getElementById('addColumnBtn') as HTMLButtonElement;
const instanceTypesSection = document.getElementById('instanceTypesSection')!;
const instanceTypesList = document.getElementById('instanceTypesList')!;
const propertyModal = document.getElementById('propertyModal')!;
const closeModalBtn = document.getElementById('closeModalBtn')!;
const propertySearch = document.getElementById('propertySearch') as HTMLInputElement;
const propertyList = document.getElementById('propertyList')!;

// State
let currentTableData: TableData | null = null;
let currentTableRecord: TableRecord | null = null;
let currentUrl: string = '';
let currentTabId: number = 0;
let rowMatches: RowMatch[] = [];
let availableProperties: PropertyStats[] = [];
let columns: SidebarColumn[] = [];

// Wikidata matching state (stored for re-filtering)
let storedLabelToQidMap: Map<string, Map<string, { itemLabel: string; instanceOf: string[] }>> | null = null;
let storedRowToLabel: Map<number, string> = new Map();
let storedKeyColumnIndex: number = 0;
let storedPrimaryInstanceTypes: string[] = [];
let selectedInstanceTypes: Set<string> = new Set(); // checked instance type filters

// Helper: Convert column index to letter (A, B, C, ... AA, AB, etc.)
function indexToLetter(index: number): string {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

// Helper: Show specific UI state
function showState(state: 'picker' | 'empty' | 'loading' | 'editor'): void {
  tablePicker.style.display = state === 'picker' ? 'flex' : 'none';
  emptyState.style.display = state === 'empty' ? 'flex' : 'none';
  loadingState.style.display = state === 'loading' ? 'flex' : 'none';
  tableEditor.style.display = state === 'editor' ? 'flex' : 'none';
}

function setLoadingMessage(message: string): void {
  loadingMessage.textContent = message;
  console.log(`WikiColumn: Sidebar Loading Message: ${message}`);
}

// Helper: Detect key column (first column with Wikipedia links)
function detectKeyColumn(tableData: TableData): number {
  // Check each column for Wikipedia links
  for (let colIndex = 0; colIndex < tableData.headers.length; colIndex++) {
    let hasWikipediaLinks = false;

    for (const row of tableData.rows) {
      const cell = row[colIndex];
      if (cell && cell.links.some((link) => link.isWikipedia)) {
        hasWikipediaLinks = true;
        break;
      }
    }

    if (hasWikipediaLinks) {
      return colIndex;
    }
  }

  // Default to first column if no Wikipedia links found
  return 0;
}

// Render columns list in sidebar
function renderColumns(): void {
  columnsList.innerHTML = '';

  columns.forEach((col) => {
    const item = document.createElement('div');
    item.className = `column-item${col.isWikidata ? ' wikidata-column' : ''}${col.isKey ? ' key-column' : ''}`;
    item.draggable = true;
    item.dataset.index = col.index.toString();

    item.innerHTML = `
      <span class="column-letter">${col.letter}</span>
      <span class="column-name">${escapeHtml(col.header)}</span>
      ${col.isKey ? '<span class="column-key-icon" title="Key column for Wikidata matching"></span>' : ''}
      ${col.isWikidata ? `
        <div class="column-actions">
          <button class="column-action-btn delete" title="Remove column" data-position="${col.position}">🗑️</button>
        </div>
      ` : ''}
    `;

    // Handle delete button click
    const deleteBtn = item.querySelector('.column-action-btn.delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const positionStr = (e.target as HTMLElement).dataset.position;
        if (positionStr !== undefined) {
          removeWikidataColumn(parseInt(positionStr, 10));
        }
      });
    }

    // Handle click on non-Wikidata columns to switch key column
    // col.index is 0 indexed.
    if (!col.isWikidata && !col.isKey) {
      item.style.cursor = 'pointer';
      item.title = 'Click to set as key column';
      item.addEventListener('click', () => {
        switchKeyColumn(col.index);
      });
    }

    columnsList.appendChild(item);
  });
}

// Switch the key column and re-run Wikidata matching
async function switchKeyColumn(newKeyIndex: number): Promise<void> {
  if (!currentTableData || !currentTableRecord) return;

  // Update columns array
  columns = columns.map((col) => ({
    ...col,
    isKey: col.index === newKeyIndex,
  }));

  // Update table record
  currentTableRecord.keyColumnIndex = newKeyIndex;
  currentTableRecord.updatedAt = new Date().toISOString();
  await db.saveTable(currentTableRecord);

  // Re-render columns
  renderColumns();

  // Show loading state and re-run matching
  showState('loading');
  setLoadingMessage('Switching key column...');
  await matchWikidata(newKeyIndex);
  showState('editor');
}

// Update matching progress UI
function updateMatchingProgress(matched: number, total: number): void {
  const percentage = total > 0 ? Math.round((matched / total) * 100) : 0;
  matchingProgressFill.style.width = `${percentage}%`;
  matchingProgressText.textContent = `${percentage}%`;
  matchingStatus.textContent = `${matched} of ${total} rows matched`;
}

// Render property list in modal
function renderPropertyList(searchQuery: string = ''): void {
  const filteredProperties = availableProperties.filter((prop) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      prop.label.toLowerCase().includes(query) ||
      prop.description.toLowerCase().includes(query)
    );
  });

  // Sort by: 1) global usage (descending), 2) percentage (descending)
  filteredProperties.sort((a, b) => {
    if (b.globalUsage !== a.globalUsage) {
      return b.globalUsage - a.globalUsage;
    }
    return b.percentage - a.percentage;
  });

  propertyList.innerHTML = '';

  if (filteredProperties.length === 0) {
    propertyList.innerHTML = '<div class="property-item"><span class="property-info"><span class="property-label">No properties found</span></span></div>';
    return;
  }

  filteredProperties.forEach((prop) => {
    const item = document.createElement('div');
    item.className = `property-item${prop.visible ? '' : ' hidden'}`;
    item.dataset.pid = prop.pid;

    item.innerHTML = `
      <div class="property-info">
        <div class="property-label">${escapeHtml(prop.label)}</div>
        <div class="property-description">${escapeHtml(prop.description)}</div>
      </div>
      <span class="property-usage">${prop.percentage}%</span>
      <button class="property-visibility-btn" title="${prop.visible ? 'Hide' : 'Show'}">${prop.visible ? '👁️' : '👁️‍🗨️'}</button>
    `;

    // Click on property to add column
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('property-visibility-btn')) {
        return;
      }
      try {
        addWikidataColumn(prop.pid, prop.label);
      } catch (error) {
        console.error('WikiColumn: Error adding Wikidata column after click:', error);
      }
      closePropertyModal();
    });

    // Click on visibility button
    const visibilityBtn = item.querySelector('.property-visibility-btn');
    if (visibilityBtn) {
      visibilityBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        prop.visible = !prop.visible;
        await db.updatePropertyVisibility(prop.pid, prop.visible);
        renderPropertyList(searchQuery);
      });
    }

    propertyList.appendChild(item);
  });
}

// Render instance types list in the sidebar
const INSTANCE_TYPES_INITIAL_LIMIT = 5;

function renderInstanceTypes(
  instanceOfScores: Map<string, number>,
  primaryInstanceTypes: string[]
): void {
  instanceTypesList.innerHTML = '';

  if (instanceOfScores.size === 0) {
    instanceTypesSection.style.display = 'none';
    return;
  }

  instanceTypesSection.style.display = 'block';

  // Sort by score descending
  const sortedTypes = Array.from(instanceOfScores.entries())
    .sort((a, b) => b[1] - a[1]);

  const hasMoreItems = sortedTypes.length > INSTANCE_TYPES_INITIAL_LIMIT;
  let isExpanded = false;

  function renderItems(showAll: boolean): void {
    instanceTypesList.innerHTML = '';
    const itemsToShow = showAll ? sortedTypes : sortedTypes.slice(0, INSTANCE_TYPES_INITIAL_LIMIT);

    for (const [type, score] of itemsToShow) {
      const li = document.createElement('li');
      li.className = 'instance-type-item';

      const isPrimary = primaryInstanceTypes.includes(type);
      if (isPrimary) {
        li.classList.add('primary');
      }

      const isChecked = selectedInstanceTypes.has(type);

      li.innerHTML = `
        <input type="checkbox" class="instance-type-checkbox" data-type="${type}" ${isChecked ? 'checked' : ''}>
        <span class="instance-type-name">${type}</span>
        <span class="instance-type-score">${score}%</span>
      `;

      // Add checkbox change handler
      const checkbox = li.querySelector('.instance-type-checkbox') as HTMLInputElement;
      checkbox.addEventListener('change', async () => {
        if (checkbox.checked) {
          selectedInstanceTypes.add(type);
        } else {
          selectedInstanceTypes.delete(type);
        }
        await refilterRowMatches();

        // Persist selected instance types to database
        if (currentTableRecord) {
          currentTableRecord.selectedInstanceTypes = Array.from(selectedInstanceTypes);
          currentTableRecord.updatedAt = new Date().toISOString();
          await db.saveTable(currentTableRecord);
        }
      });

      instanceTypesList.appendChild(li);
    }

    // Add "Show more/less" button if there are more than INSTANCE_TYPES_INITIAL_LIMIT items
    if (hasMoreItems) {
      const toggleLi = document.createElement('li');
      toggleLi.className = 'instance-type-toggle';
      const remainingCount = sortedTypes.length - INSTANCE_TYPES_INITIAL_LIMIT;
      toggleLi.innerHTML = showAll
        ? '<button class="instance-type-toggle-btn">Show less</button>'
        : `<button class="instance-type-toggle-btn">Show ${remainingCount} more...</button>`;

      const toggleBtn = toggleLi.querySelector('.instance-type-toggle-btn') as HTMLButtonElement;
      toggleBtn.addEventListener('click', () => {
        isExpanded = !isExpanded;
        renderItems(isExpanded);
      });

      instanceTypesList.appendChild(toggleLi);
    }
  }

  renderItems(false);
}

// Re-filter row matches based on selected instance types
async function refilterRowMatches(): Promise<void> {
  if (!currentTableData || !storedLabelToQidMap) return;

  // Rebuild row matches with instance type filter
  rowMatches = currentTableData.rows.map((_, rowIndex) => {
    const label = storedRowToLabel.get(rowIndex);
    const strippedLabel = label ? label.replace(/^\d+\.\s*/, '').replace(/‡$/, '').trim() : label;
    const qidMap = strippedLabel ? storedLabelToQidMap!.get(strippedLabel) : undefined;

    let qid: string | null = null;
    let itemLabel: string | undefined;

    if (qidMap && qidMap.size > 0) {
      // If no filters selected, use first QID (original behavior)
      if (selectedInstanceTypes.size === 0) {
        const firstEntry = qidMap.entries().next().value;
        if (firstEntry) {
          qid = firstEntry[0];
          itemLabel = firstEntry[1].itemLabel;
        }
      } else {
        // Filter QIDs to those with at least one selected instance type
        for (const [thisQid, labelMatch] of qidMap.entries()) {
          const hasSelectedType = labelMatch.instanceOf.some(
            (type) => selectedInstanceTypes.has(type)
          );
          if (hasSelectedType) {
            qid = thisQid;
            itemLabel = labelMatch.itemLabel;
            break; // Use first matching QID
          }
        }
      }
    }

    return {
      rowIndex,
      qid,
      label: itemLabel || label,
    };
  });

  // Update matching progress
  const matchedCount = rowMatches.filter((m) => m.qid).length;
  updateMatchingProgress(matchedCount, rowMatches.length);

  // Update status text
  matchingStatus.textContent = matchedCount > 0
    ? `${matchedCount} of ${rowMatches.length} rows matched`
    : 'No matches found';

  // Update instance of on page with new filtered data
  if (currentTableRecord && storedLabelToQidMap) {
    await updateInstanceOfOnPage(
      storedKeyColumnIndex,
      storedLabelToQidMap,
      storedPrimaryInstanceTypes
    );
  }

  // Recalculate available properties based on filtered row matches
  const filteredQids = rowMatches.filter((m) => m.qid).map((m) => m.qid!);
  await calculatePropertyStats(filteredQids);
}

// Open property picker modal
function openPropertyModal(): void {
  propertyModal.style.display = 'flex';
  propertySearch.value = '';
  renderPropertyList();
  propertySearch.focus();
}

// Close property picker modal
function closePropertyModal(): void {
  propertyModal.style.display = 'none';
}

// Escape HTML to prevent XSS
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// Table Picker
// ============================================================================

// Store eligible tables for the current page
let eligibleTables: EligibleTableInfo[] = [];

// Request eligible tables from the content script
async function requestEligibleTables(): Promise<void> {
  try {
    tablePickerStatus.textContent = 'Scanning page for tables...';
    tablePickerList.innerHTML = '';

    const response = await browser.tabs.sendMessage(currentTabId, {
      type: 'GET_ELIGIBLE_TABLES',
    }) as { tables: EligibleTableInfo[]; url: string };

    if (response && response.tables) {
      eligibleTables = response.tables;
      currentUrl = response.url;
      renderTablePicker();
    } else {
      showState('empty');
    }
  } catch (error) {
    console.error('WikiColumn: Error requesting eligible tables:', error);
    tablePickerStatus.textContent = 'Error scanning page. Try refreshing.';
  }
}

// Render the table picker list
function renderTablePicker(): void {
  tablePickerList.innerHTML = '';

  if (eligibleTables.length === 0) {
    showState('empty');
    return;
  }

  tablePickerStatus.textContent = `Found ${eligibleTables.length} table${eligibleTables.length > 1 ? 's' : ''}`;

  for (const table of eligibleTables) {
    const item = document.createElement('div');
    item.className = 'table-picker-item';
    item.dataset.xpath = table.xpath;

    const wikipediaBadgeHtml = table.hasWikipediaLinks
      ? '<span class="table-picker-item-badge">🔗 Wikipedia</span>'
      : '';

    const savedColumnCount = table.savedColumns?.length || 0;
    const savedColumnsBadgeHtml = savedColumnCount > 0
      ? `<span class="table-picker-item-badge table-picker-item-badge-saved">+${savedColumnCount} column${savedColumnCount > 1 ? 's' : ''}</span>`
      : '';

    item.innerHTML = `
      <div class="table-picker-item-title">${escapeHtml(table.title)}${wikipediaBadgeHtml}${savedColumnsBadgeHtml}</div>
      <div class="table-picker-item-info">${table.rowCount} rows, ${table.columnCount} columns</div>
    `;

    item.addEventListener('click', () => selectTable(table.xpath));
    tablePickerList.appendChild(item);
  }

  showState('picker');
}

// Select a table from the picker and load it
async function selectTable(xpath: string): Promise<void> {
  showState('loading');
  setLoadingMessage('Extracting table data...');

  try {
    const response = await browser.tabs.sendMessage(currentTabId, {
      type: 'EXTRACT_TABLE',
      payload: { xpath },
    }) as { tableData?: TableData; url?: string; error?: string };

    if (response && response.tableData) {
      // Scroll to the table on the page
      browser.tabs.sendMessage(currentTabId, {
        type: 'SCROLL_TO_TABLE',
        payload: { xpath },
      });

      await loadTable({
        tableData: response.tableData,
        url: response.url || currentUrl,
        tabId: currentTabId,
      });

    } else {
      console.error('WikiColumn: Failed to extract table:', response?.error);
      showState('picker');
    }
  } catch (error) {
    console.error('WikiColumn: Error selecting table:', error);
    showState('picker');
  }
}

// Go back to the table picker
function goBackToPicker(): void {
  currentTableData = null;
  currentTableRecord = null;
  rowMatches = [];
  availableProperties = [];
  columns = [];
  storedLabelToQidMap = null;
  storedRowToLabel.clear();
  selectedInstanceTypes.clear();

  showState('picker');
  requestEligibleTables();
}

// Main function: Load table and start Wikidata matching
async function loadTable(payload: EditTablePayload): Promise<void> {
  showState('loading');
  setLoadingMessage('Loading table...');
  console.log('WikiColumn: Loading table in sidebar...', payload);

  currentTableData = payload.tableData;
  currentUrl = payload.url;

  // Check if table already exists in database - use saved keyColumnIndex as source of truth
  let tableRecord = await db.getTableByUrlAndXpath(currentUrl, currentTableData.xpath);

  let keyColumnIndex: number;
  if (tableRecord) {
    // Use saved key column index from database
    keyColumnIndex = tableRecord.keyColumnIndex;
    if (LOG_LEVEL > 1) console.log('WikiColumn: Using saved keyColumnIndex from DB:', keyColumnIndex);
  } else {
    // Detect key column for new tables
    keyColumnIndex = detectKeyColumn(currentTableData);
    if (LOG_LEVEL > 1) console.log('WikiColumn: Detected keyColumnIndex for new table:', keyColumnIndex);

    // Create new table record
    tableRecord = {
      id: generateId(),
      url: currentUrl,
      tableTitle: currentTableData.tableTitle || 'Untitled Table',
      xpath: currentTableData.xpath,
      originalColumns: currentTableData.headers.map((h, i) => ({
        index: i,
        header: h.text,
        headerHtml: h.html,
      })),
      addedColumns: [],
      keyColumnIndex,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.saveTable(tableRecord);
    if (LOG_LEVEL > 1) console.log("WikiColumn: Created new table record in DB:", tableRecord);
  }

  currentTableRecord = tableRecord;

  // Build columns array using the authoritative keyColumnIndex
  // Start with original columns only (not any already-injected Wikidata columns)
  const originalColumnCount = tableRecord.originalColumns.length;
  columns = currentTableData.headers.slice(0, originalColumnCount).map((header, index) => ({
    letter: indexToLetter(index),
    index,
    header: header.text,
    isKey: index === keyColumnIndex,
    isWikidata: false,
  }));

  // Add saved Wikidata columns to the display
  for (const addedColumn of tableRecord.addedColumns) {
    columns.push({
      letter: indexToLetter(columns.length),
      index: columns.length,
      header: addedColumn.label.toLocaleUpperCase(),
      isKey: false,
      isWikidata: true,
      propertyId: addedColumn.propertyId,
      position: addedColumn.position,
    });
  }

  // Update UI
  tableTitle.textContent = tableRecord.tableTitle || 'Table';
  tableStats.textContent = `${currentTableData.rows.length} rows, ${currentTableData.headers.length} columns`;
  renderColumns();

  if (LOG_LEVEL > 0) console.log('WikiColumn: Starting Wikidata matching for table:', tableRecord);
  // Start Wikidata matching
  await matchWikidata(keyColumnIndex);

  showState('editor');
}

// Match rows to Wikidata entities
async function matchWikidata(keyColumnIndex: number): Promise<void> {
  if (!currentTableData) return;

  setLoadingMessage('Matching rows to Wikidata...');
  matchingSection.style.display = 'block';
  updateMatchingProgress(0, currentTableData.rows.length);

  // Collect text labels from key column
  const labels: string[] = [];
  const rowToLabel = new Map<number, string>();

  currentTableData.rows.forEach((row, rowIndex) => {
    const cell = row[keyColumnIndex];
    if (cell && cell.text.trim()) {
      const label = cell.text.replace(/^\d+\.\s*/, '').replace(/(‡|§)$/, '').trim();
      labels.push(label);
      rowToLabel.set(rowIndex, label);
    }
  });

  // Get QIDs from labels using SPARQL (with caching)
  setLoadingMessage('Searching Wikidata by label...');
  const labelToQidMap = await getCachedEntitiesByLabel(labels, PRIMARY_LANGUAGE);

  // Determine the primary instanceOf by creating a dictionary of instanceOf scores.
  // The score is calculated by determining the COUNT of how many instancesOf per QID and incrementing
  // the score by 1 for each QID.
  setLoadingMessage('Analyzing entity types...');

  // Calculate scores: count how many rows (labels) have at least one QID with each instanceOf type
  const instanceOfCounts = new Map<string, number>();
  const totalLabelsWithResults = labelToQidMap.size;

  for (const qidMap of labelToQidMap.values()) {
    // Collect all unique instance types for this row
    const typesForThisRow = new Set<string>();
    for (const labelMatch of qidMap.values()) {
      for (const instanceType of labelMatch.instanceOf) {
        if (instanceType) {
          typesForThisRow.add(instanceType);
        }
      }
    }
    // Count each type once per row
    for (const type of typesForThisRow) {
      instanceOfCounts.set(type, (instanceOfCounts.get(type) || 0) + 1);
    }
  }

  // Convert counts to percentages
  const instanceOfScores = new Map<string, number>();
  for (const [type, count] of instanceOfCounts) {
    const percentage = totalLabelsWithResults > 0
      ? Math.round((count / totalLabelsWithResults) * 100)
      : 0;
    instanceOfScores.set(type, percentage);
  }

  // Find the highest score(s) - these are the primary instance types
  let primaryInstanceTypes: string[] = [];
  if (instanceOfScores.size > 0) {
    const maxScore = Math.max(...instanceOfScores.values());
    primaryInstanceTypes = Array.from(instanceOfScores.entries())
      .filter(([_, score]) => score === maxScore)
      .map(([type, _]) => type);
  }

  if (LOG_LEVEL > 1) {
    console.log('WikiColumn: InstanceOf scores:', Object.fromEntries(instanceOfScores));
    console.log('WikiColumn: Primary instance types:', primaryInstanceTypes);
  }

  // Store data for re-filtering when instance type checkboxes change
  storedLabelToQidMap = labelToQidMap;
  storedRowToLabel = rowToLabel;
  storedKeyColumnIndex = keyColumnIndex;
  storedPrimaryInstanceTypes = primaryInstanceTypes;

  // Restore saved instance type selections, or clear for new table
  selectedInstanceTypes.clear();
  if (currentTableRecord?.selectedInstanceTypes?.length) {
    for (const type of currentTableRecord.selectedInstanceTypes) {
      selectedInstanceTypes.add(type);
    }
    if (LOG_LEVEL > 1) console.log('WikiColumn: Restored saved instance types:', currentTableRecord.selectedInstanceTypes);
  }

  // Render the instance types in the sidebar
  renderInstanceTypes(instanceOfScores, primaryInstanceTypes);

  // Build row matches
  rowMatches = currentTableData.rows.map((_, rowIndex) => {
    const label = rowToLabel.get(rowIndex);

    // strip prefix number and period from label if present
    const strippedLabel = label ? label.replace(/^\d+\.\s*/, '').replace(/‡$/, '').trim() : label;

    const qidMap = strippedLabel ? labelToQidMap.get(strippedLabel) : undefined;

    // For now, pick the first QID (TODO: add disambiguation UI)
    let qid: string | null = null;
    let itemLabel: string | undefined;
    if (qidMap && qidMap.size > 0) {
      const firstEntry = qidMap.entries().next().value;
      if (firstEntry) {
        qid = firstEntry[0];
        itemLabel = firstEntry[1].itemLabel;
      }
    }

    return {
      rowIndex,
      qid,
      label: itemLabel || label,
    };
  });

  const matchedCount = rowMatches.filter((m) => m.qid).length;
  updateMatchingProgress(matchedCount, rowMatches.length);

  // Fetch entity data for matched QIDs (with caching)
  const qids = rowMatches.filter((m) => m.qid).map((m) => m.qid!);
  if (qids.length > 0) {
    setLoadingMessage('Fetching entity data...');
    const entityData = await getCachedEntityData(qids, PRIMARY_LANGUAGE);

    // Items are already saved to cache by getCachedEntityData
    const items = Array.from(entityData.values());

    // Parse and save claims
    setLoadingMessage('Processing claims...');
    const allClaims: Claim[] = [];
    const allPropertyIds = new Set<string>();

    for (const item of items) {
      const claims = parseClaims(item.json);
      allClaims.push(...claims);
      claims.forEach((claim) => allPropertyIds.add(claim.pid));
    }

    await db.saveClaims(allClaims);

    // Fetch property info (with caching) - this also saves to cache
    setLoadingMessage('Fetching property labels...');
    await getCachedPropertyInfo(Array.from(allPropertyIds), PRIMARY_LANGUAGE);

    // Calculate property usage statistics
    await calculatePropertyStats(qids);

    // Update key column with filtered instance types
    setLoadingMessage('Updating instance types...');
    await updateInstanceOfOnPage(keyColumnIndex, labelToQidMap, primaryInstanceTypes);

    // If there are saved instance type selections, apply them now
    if (selectedInstanceTypes.size > 0) {
      setLoadingMessage('Applying saved entity type filters...');
      await refilterRowMatches();
    }
  }

  // Enable add column button if we have matched rows
  const filteredMatchedCount = rowMatches.filter((m) => m.qid).length;
  addColumnBtn.disabled = filteredMatchedCount === 0;
  matchingStatus.textContent = filteredMatchedCount > 0
    ? `${filteredMatchedCount} of ${rowMatches.length} rows matched`
    : 'No Wikipedia links found. Add Wikipedia links to enable Wikidata columns.';
}

// Update key column cells with instance of labels (filtered to primary types)
async function updateInstanceOfOnPage(
  keyColumnIndex: number,
  labelToQidMap: Map<string, Map<string, { itemLabel: string; instanceOf: string[] }>>,
  primaryInstanceTypes: string[]
): Promise<void> {
  if (!currentTableRecord || !currentTableData) return;

  // Build row index -> instance of label map
  const instanceOfData: Record<number, string> = {};

  for (const match of rowMatches) {
    if (!match.qid || !match.label) continue;

    // Find the label in labelToQidMap
    const strippedLabel = match.label.replace(/^\d+\.\s*/, '').replace(/‡$/, '').trim();
    const qidMap = labelToQidMap.get(strippedLabel);
    if (!qidMap) continue;

    // Get the instanceOf for this QID
    const labelMatch = qidMap.get(match.qid);
    if (!labelMatch) continue;

    // Filter to only include primary instance types
    const filteredTypes = labelMatch.instanceOf.filter(
      (type) => primaryInstanceTypes.includes(type)
    );

    if (filteredTypes.length > 0) {
      instanceOfData[match.rowIndex] = filteredTypes.join(', ');
    }
  }

  // Send to content script
  try {
    await browser.tabs.sendMessage(currentTabId, {
      type: 'UPDATE_INSTANCE_OF',
      payload: {
        xpath: currentTableRecord.xpath,
        keyColIndex: keyColumnIndex,
        instanceOfData,
      },
    });
  } catch (error) {
    console.error('WikiColumn: Error updating instance of on page:', error);
  }
}

// Calculate property usage statistics
async function calculatePropertyStats(qids: string[]): Promise<void> {
  const propertyCounts = new Map<string, number>();
  const totalRows = qids.length;

  // Count property usage across all QIDs
  for (const qid of qids) {
    const claims = await db.getClaimsByQid(qid);
    const seenProperties = new Set<string>();

    for (const claim of claims) {
      if (!seenProperties.has(claim.pid)) {
        seenProperties.add(claim.pid);
        propertyCounts.set(claim.pid, (propertyCounts.get(claim.pid) || 0) + 1);
      }
    }
  }

  // Build property stats
  availableProperties = [];

  for (const [pid, count] of propertyCounts) {
    const property = await db.getProperty(pid);
    if (property) {
      availableProperties.push({
        pid,
        label: property.label,
        description: property.description,
        count,
        percentage: Math.round((count / totalRows) * 100),
        visible: property.visible,
        globalUsage: property.usage || 0,
      });
    }
  }

  // Sort by: 1) global usage (descending), 2) percentage (descending)
  availableProperties.sort((a, b) => {
    if (b.globalUsage !== a.globalUsage) {
      return b.globalUsage - a.globalUsage;
    }
    return b.percentage - a.percentage;
  });
}

// Add a Wikidata column to the table
async function addWikidataColumn(propertyId: string, label: string): Promise<void> {
  if (!currentTableData || !currentTableRecord) return;

  showState('loading');
  setLoadingMessage('Adding column...');

  // Get claim values for each row
  const qids = rowMatches.filter((m) => m.qid).map((m) => m.qid!);
  const claimsByQid = await db.getClaimsByQids(qids);

  // Filter claims for the selected property
  const relevantClaims: Claim[] = [];
  for (const [, claims] of claimsByQid) {
    const claim = claims.find((c) => c.pid === propertyId);
    if (claim) {
      relevantClaims.push(claim);
    }
  }

  console.log("WikiColumn: Adding Wikidata column:", propertyId, label, relevantClaims);

  // Get display values for claims
  const displayValues = await getClaimDisplayValues(relevantClaims, PRIMARY_LANGUAGE);

  // Build column values array
  const values: string[] = [];
  for (const match of rowMatches) {
    if (match.qid) {
      const qidValues = displayValues.get(match.qid);
      const value = qidValues?.get(propertyId) || '';
      values.push(value || '🤔'); // Confused emoji for missing values
    } else {
      values.push('🤔'); // Confused emoji for unmatched rows
    }
  }

  // Create header HTML based on existing column style
  const originalHeader = currentTableRecord.originalColumns[0];
  const headerHtml = originalHeader
    ? originalHeader.headerHtml.replace(
        new RegExp(escapeRegExp(originalHeader.header), 'g'),
      toTitleCase(label))
    : label;
  if (LOG_LEVEL > 2) console.log("WikiColumn: Generated header HTML for new column:", headerHtml, label, originalHeader);

  // Add column to table record
  const newColumn = {
    propertyId,
    label,
    position: currentTableRecord.addedColumns.length,
  };
  currentTableRecord.addedColumns.push(newColumn);
  currentTableRecord.updatedAt = new Date().toISOString();
  await db.saveTable(currentTableRecord);

  // Increment global property usage count
  await db.incrementPropertyUsage(propertyId);

  // Add to columns display
  columns.push({
    letter: indexToLetter(columns.length),
    index: columns.length,
    header: label.toLocaleUpperCase(),
    isKey: false,
    isWikidata: true,
    propertyId,
    position: newColumn.position,
  });

  // Send message to content script to inject column (after key column)
  const injectPayload: InjectColumnsPayload = {
    xpath: currentTableRecord.xpath,
    afterColumnIndex: currentTableRecord.keyColumnIndex,
    columns: [{
      propertyId,
      label,
      headerHtml,
      values,
      position: newColumn.position,
    }],
  };
  console.log('WikiColumn: Injecting column with payload:', injectPayload, currentTabId);
  try {
    await browser.tabs.sendMessage(currentTabId, {
      type: 'INJECT_COLUMNS',
      payload: injectPayload,
    });
  } catch (error) {
    console.error('WikiColumn: Error injecting column:', error);
  }

  renderColumns();
  showState('editor');
}

// Remove a Wikidata column by its unique position identifier
async function removeWikidataColumn(position: number): Promise<void> {
  if (!currentTableRecord) return;

  // Find the column to get the propertyId for the payload
  const columnToRemove = currentTableRecord.addedColumns.find(
    (col) => col.position === position
  );
  if (!columnToRemove) {
    console.error('WikiColumn: Column not found for position:', position);
    return;
  }

  // Remove from table record
  currentTableRecord.addedColumns = currentTableRecord.addedColumns.filter(
    (col) => col.position !== position
  );
  currentTableRecord.updatedAt = new Date().toISOString();
  await db.saveTable(currentTableRecord);

  // Remove from columns display
  columns = columns.filter((col) => col.position !== position);

  // Reassign letters
  columns.forEach((col, index) => {
    col.letter = indexToLetter(index);
    col.index = index;
  });

  // Send message to content script to remove column
  try {
    await browser.tabs.sendMessage(currentTabId, {
      type: 'REMOVE_COLUMN',
      payload: {
        tableId: currentTableRecord.id,
        propertyId: columnToRemove.propertyId,
        position,
        xpath: currentTableRecord.xpath,
      },
    });
  } catch (error) {
    console.error('WikiColumn: Error removing column:', error);
  }

  renderColumns();
}

// Helper: Escape string for use in RegExp
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scroll to the table on the page
async function scrollToTable(): Promise<void> {
  if (!currentTableRecord) return;

  try {
    await browser.tabs.sendMessage(currentTabId, {
      type: 'SCROLL_TO_TABLE',
      payload: { xpath: currentTableRecord.xpath },
    });
  } catch (error) {
    console.error('WikiColumn: Error scrolling to table:', error);
  }
}

function toTitleCase(str: string): string {
  return str.replace(
    /\w\S*/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

// Event listeners
addColumnBtn.addEventListener('click', openPropertyModal);
closeModalBtn.addEventListener('click', closePropertyModal);
backToPickerBtn.addEventListener('click', goBackToPicker);
tableTitle.addEventListener('click', scrollToTable);
tableTitle.style.cursor = 'pointer';
tableTitle.title = 'Click to scroll to table';

propertySearch.addEventListener('input', () => {
  renderPropertyList(propertySearch.value);
});

propertyModal.addEventListener('click', (e) => {
  if (e.target === propertyModal) {
    closePropertyModal();
  }
});

// Highlight unmatched rows on hover
matchingStatus.addEventListener('mouseenter', async () => {
  if (!currentTableData || !currentTableRecord || !rowMatches.length) {
    console.error('WikiColumn: No table data or row matches available for highlighting.', { currentTableData, currentTableRecord, rowMatches });
    return;
  } else {
    if (LOG_LEVEL > 1) console.log('WikiColumn: Preparing to highlight unmatched rows.', { currentTableData, currentTableRecord, rowMatches });
  }

  // Get labels of unmatched rows
  const unmatchedLabels = rowMatches
    .filter((match) => !match.qid)
    .map((match) => match.label)
    .filter((label): label is string => !!label);

  if (unmatchedLabels.length === 0) return;

  // Send message to content script
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    browser.tabs.sendMessage(tabs[0].id, {
      type: 'HIGHLIGHT_NOT_FOUND_ON',
      payload: {
        xpath: currentTableData.xpath,
        labels: unmatchedLabels,
        keyColumnIndex: currentTableRecord.keyColumnIndex,
      },
    });
  }
});

matchingStatus.addEventListener('mouseleave', async () => {
  if (!currentTableData) return;

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    browser.tabs.sendMessage(tabs[0].id, {
      type: 'HIGHLIGHT_NOT_FOUND_OFF',
      payload: {
        xpath: currentTableData.xpath,
      },
    });
  }
});

// Listen for messages from background script
browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'EDIT_TABLE') {
    loadTable(message.payload as EditTablePayload);
  }
  return true;
});

// Track active tab changes
browser.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  if (LOG_LEVEL > 1) console.log('WikiColumn: Active tab changed to', currentTabId);

  // If we're on the table picker, refresh the table list
  if (tablePicker.style.display !== 'none') {
    await requestEligibleTables();
  }
});

// Track tab refreshes/reloads
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
  // Only respond to the active tab completing a load
  if (tabId !== currentTabId || changeInfo.status !== 'complete') {
    return;
  }

  if (LOG_LEVEL > 1) console.log('WikiColumn: Tab refreshed, resetting sidebar');

  // Reset state and go back to picker
  currentTableData = null;
  currentTableRecord = null;
  rowMatches = [];
  availableProperties = [];
  columns = [];
  storedLabelToQidMap = null;
  storedRowToLabel.clear();
  selectedInstanceTypes.clear();

  showState('picker');
  await requestEligibleTables();
});

// Initialize
async function init(): Promise<void> {
  showState('picker');
  await db.init();

  // Get the current active tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    currentTabId = tabs[0].id;
  }

  console.log('WikiColumn sidebar initialized, active tab:', currentTabId);

  // Request eligible tables from the current page
  if (currentTabId) {
    await requestEligibleTables();
  }
}

init();

