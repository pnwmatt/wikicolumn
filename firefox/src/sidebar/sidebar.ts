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
} from '../lib/types';
import { db } from '../lib/database';
import { generateId } from '../lib/utils';
import {
  queryEntitiesByLabel,
  getEntityData,
  parseClaims,
  getPropertyInfo,
  getClaimDisplayValues,
} from '../lib/wikidata';

const LOG_LEVEL = 5;

// DOM Elements
const emptyState = document.getElementById('emptyState')!;
const loadingState = document.getElementById('loadingState')!;
const loadingMessage = document.getElementById('loadingMessage')!;
const tableEditor = document.getElementById('tableEditor')!;
const tableTitle = document.getElementById('tableTitle')!;
const tableStats = document.getElementById('tableStats')!;
const columnsList = document.getElementById('columnsList')!;
const matchingSection = document.getElementById('matchingSection')!;
const matchingProgressFill = document.getElementById('matchingProgressFill')!;
const matchingProgressText = document.getElementById('matchingProgressText')!;
const matchingStatus = document.getElementById('matchingStatus')!;
const addColumnBtn = document.getElementById('addColumnBtn') as HTMLButtonElement;
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
function showState(state: 'empty' | 'loading' | 'editor'): void {
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
    item.className = `column-item${col.isWikidata ? ' wikidata-column' : ''}`;
    item.draggable = true;
    item.dataset.index = col.index.toString();

    item.innerHTML = `
      <span class="column-letter">${col.letter}</span>
      <span class="column-name">${escapeHtml(col.header)}</span>
      ${col.isKey ? '<span class="column-key-icon" title="Key column for Wikidata matching"></span>' : ''}
      ${col.isWikidata ? `
        <div class="column-actions">
          <button class="column-action-btn delete" title="Remove column" data-property="${col.propertyId}">🗑️</button>
        </div>
      ` : ''}
    `;

    // Handle delete button click
    const deleteBtn = item.querySelector('.column-action-btn.delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const propertyId = (e.target as HTMLElement).dataset.property;
        if (propertyId) {
          removeWikidataColumn(propertyId);
        }
      });
    }

    columnsList.appendChild(item);
  });
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

  // Sort by usage percentage (descending)
  filteredProperties.sort((a, b) => b.percentage - a.percentage);

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

// Main function: Load table and start Wikidata matching
async function loadTable(payload: EditTablePayload): Promise<void> {
  showState('loading');
  setLoadingMessage('Loading table...');
  console.log('WikiColumn: Loading table in sidebar...', payload);

  currentTableData = payload.tableData;
  currentUrl = payload.url;

  // Detect key column
  const keyColumnIndex = detectKeyColumn(currentTableData);

  // Build columns array
  columns = currentTableData.headers.map((header, index) => ({
    letter: indexToLetter(index),
    index,
    header: header.text,
    isKey: index === keyColumnIndex,
    isWikidata: false,
  }));

  // Check if table already exists in database
  let tableRecord = await db.getTableByUrlAndXpath(currentUrl, currentTableData.xpath);

  if (LOG_LEVEL > 1) console.log('WikiColumn: Loaded table record from DB:', tableRecord);
  if (!tableRecord) {
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

  // Get QIDs from labels using SPARQL
  setLoadingMessage('Searching Wikidata by label...');
  const labelToQidMap = await queryEntitiesByLabel(labels, PRIMARY_LANGUAGE);

  // Determine the primary instanceOf by creating a dictionary of instanceOf scores.
  // The score is calculated by determining the COUNT of how many instancesOf per QID and incrementing
  // the score by 1 for each QID.
  setLoadingMessage('Analyzing entity types...');

  // Calculate scores for each instanceOf type
  const instanceOfScores = new Map<string, number>();
  for (const qidMap of labelToQidMap.values()) {
    for (const labelMatch of qidMap.values()) {
      // labelMatch is { itemLabel, instanceOf[] }
      for (const instanceType of labelMatch.instanceOf) {
        if (instanceType) {
          instanceOfScores.set(instanceType, (instanceOfScores.get(instanceType) || 0) + 1);
        }
      }
    }
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

  // Fetch entity data for matched QIDs
  const qids = rowMatches.filter((m) => m.qid).map((m) => m.qid!);
  if (qids.length > 0) {
    setLoadingMessage('Fetching entity data...');
    const entityData = await getEntityData(qids, PRIMARY_LANGUAGE);

    // Save items to database
    const items = Array.from(entityData.values());
    await db.saveItems(items);

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

    // Fetch property info
    setLoadingMessage('Fetching property labels...');
    const propertyInfo = await getPropertyInfo(Array.from(allPropertyIds), PRIMARY_LANGUAGE);

    // Save properties
    const properties = Array.from(propertyInfo.values());
    await db.saveProperties(properties);

    // Calculate property usage statistics
    await calculatePropertyStats(qids);

    // Update key column with filtered instance types
    setLoadingMessage('Updating instance types...');
    await updateInstanceOfOnPage(keyColumnIndex, labelToQidMap, primaryInstanceTypes);
  }

  // Enable add column button if we have matched rows
  addColumnBtn.disabled = matchedCount === 0;
  matchingStatus.textContent = matchedCount > 0
    ? `${matchedCount} of ${rowMatches.length} rows matched`
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
      });
    }
  }

  // Sort by percentage
  availableProperties.sort((a, b) => b.percentage - a.percentage);
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
        label
      )
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

  // Add to columns display
  columns.push({
    letter: indexToLetter(columns.length),
    index: columns.length,
    header: label.toLocaleUpperCase(),
    isKey: false,
    isWikidata: true,
    propertyId,
  });

  // Send message to content script to inject column
  const injectPayload: InjectColumnsPayload = {
    xpath: currentTableRecord.xpath,
    columns: [{
      propertyId,
      label,
      headerHtml,
      values,
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

// Remove a Wikidata column
async function removeWikidataColumn(propertyId: string): Promise<void> {
  if (!currentTableRecord) return;

  // Remove from table record
  currentTableRecord.addedColumns = currentTableRecord.addedColumns.filter(
    (col) => col.propertyId !== propertyId
  );
  currentTableRecord.updatedAt = new Date().toISOString();
  await db.saveTable(currentTableRecord);

  // Remove from columns display
  columns = columns.filter((col) => col.propertyId !== propertyId);

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
        propertyId,
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

// Event listeners
addColumnBtn.addEventListener('click', openPropertyModal);
closeModalBtn.addEventListener('click', closePropertyModal);

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
browser.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  if (LOG_LEVEL > 1) console.log('WikiColumn: Active tab changed to', currentTabId);
});

// Initialize
async function init(): Promise<void> {
  showState('empty');
  await db.init();

  // Get the current active tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    currentTabId = tabs[0].id;
  }

  console.log('WikiColumn sidebar initialized, active tab:', currentTabId);
}

init();
