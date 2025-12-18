// WikiColumn - Core data types

// Primary language for Wikidata labels
export const PRIMARY_LANGUAGE = 'en';

// ============================================================================
// IndexedDB Schema Types
// ============================================================================

export interface TableRecord {
  id: string;
  url: string;
  tableTitle: string;
  xpath: string;
  originalColumns: ColumnInfo[];
  addedColumns: AddedColumn[];
  keyColumnIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface ColumnInfo {
  index: number;
  header: string;
  headerHtml: string;
}

export interface AddedColumn {
  propertyId: string;
  label: string;
  position: number;
  width?: number;
}

export interface WikidataItem {
  qid: string;
  label: string;
  description?: string;
  json?: WikidataEntity;
  cachedAt: number; // Timestamp for TTL checking
}

export interface WikidataProperty {
  pid: string;
  label: string;
  description: string;
  usage: number;
  visible: boolean;
  cachedAt: number; // Timestamp for TTL checking
}

export interface Claim {
  qid: string;
  pid: string;
  values: ClaimValue[];
  cachedAt: number; // Timestamp for TTL checking
}

// Cache entry for SPARQL label queries
export interface LabelCacheEntry {
  label: string; // The search label (key)
  results: Record<string, { itemLabel: string; instanceOf: string[] }>; // QID -> data
  cachedAt: number;
}

export interface ClaimValue {
  type: 'wikibase-item' | 'string' | 'time' | 'quantity' | 'coordinate' | 'unknown';
  value: string;
  qid?: string; // For wikibase-item type
}

// ============================================================================
// Wikidata API Response Types
// ============================================================================

export interface WikidataEntity {
  id: string;
  type: string;
  labels?: Record<string, { language: string; value: string }>;
  descriptions?: Record<string, { language: string; value: string }>;
  claims?: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { site: string; title: string }>;
}

export interface WikidataClaim {
  mainsnak: WikidataSnak;
  type: string;
  rank: string;
}

export interface WikidataSnak {
  snaktype: string;
  property: string;
  datatype?: string;
  datavalue?: WikidataDataValue;
}

export interface WikidataDataValue {
  type: string;
  value: unknown;
}

export interface WikidataTimeValue {
  time: string;
  precision: number;
  calendarmodel: string;
}

export interface WikidataQuantityValue {
  amount: string;
  unit: string;
}

export interface WikidataCoordinateValue {
  latitude: number;
  longitude: number;
  precision: number;
  globe: string;
}

// ============================================================================
// Table Data Types (for message passing)
// ============================================================================

export interface TableData {
  headers: CellData[];
  rows: CellData[][];
  xpath: string;
  tableTitle: string;
}

export interface CellData {
  text: string;
  html: string;
  links: LinkData[];
}

export interface LinkData {
  href: string;
  text: string;
  isWikipedia: boolean;
  wikipediaTitle?: string;
}

export interface RowMatch {
  rowIndex: number;
  qid: string | null;
  wikipediaUrl?: string;
  label?: string;
}

// ============================================================================
// Property Statistics (for Add Column UI)
// ============================================================================

export interface PropertyStats {
  pid: string;
  label: string;
  description: string;
  count: number;
  percentage: number;
  visible: boolean;
  globalUsage: number; // How many times this column has been added globally
}

// ============================================================================
// Message Types for Extension Communication
// ============================================================================

export type MessageType =
  | 'EDIT_TABLE'
  | 'ADD_COLUMN'
  | 'REMOVE_COLUMN'
  | 'REORDER_COLUMN'
  | 'EXTRACT_TABLE'
  | 'INJECT_COLUMNS'
  | 'OPEN_SIDEBAR'
  | 'UPDATE_INSTANCE_OF'
  | 'CONTEXT_MENU_ACTIVATED'
  | 'HIGHLIGHT_NOT_FOUND_ON'
  | 'HIGHLIGHT_NOT_FOUND_OFF'
  | 'GET_ELIGIBLE_TABLES'
  | 'ELIGIBLE_TABLES_RESPONSE'
  | 'EDIT_TABLE';

export interface EditTablePayload {
  tableData: TableData;
  url: string;
  tabId: number;
}

export interface AddColumnPayload {
  tableId: string;
  propertyId: string;
  label: string;
  position: number;
  values: Map<number, string>; // rowIndex -> display value
}

export interface RemoveColumnPayload {
  tableId: string;
  propertyId: string;
  position: number; // Unique ID for the column (from AddedColumn.position)
  xpath: string;
}

export interface ReorderColumnPayload {
  tableId: string;
  propertyId: string;
  newPosition: number;
}

export interface InjectColumnsPayload {
  xpath: string;
  afterColumnIndex: number; // Insert after this column (typically the key column)
  columns: {
    propertyId: string;
    label: string;
    headerHtml: string;
    values: string[];
    position: number; // Unique ID for the column (from AddedColumn.position)
  }[];
}

export interface ExtractTablePayload {
  xpath?: string; // If provided, extract specific table; otherwise, extract from context menu target
}

export interface UpdateInstanceOfPayload {
  xpath: string;
  keyColIndex: number;
  instanceOfData: Record<number, string>; // rowIndex -> instance of label
}

export interface ContextMenuActivatedPayload {
  url: string;
  tabId: number;
}

export interface HighlightNotFoundPayload {
  xpath: string;
  labels: string[];
  keyColumnIndex: number;
}

export interface EligibleTableInfo {
  xpath: string;
  title: string;
  rowCount: number;
  columnCount: number;
  hasWikipediaLinks: boolean;
  wikicolumnColumnIndexes: number[]; // Header cell indexes of WikiColumn-added columns
  savedColumns?: AddedColumn[]; // Columns saved in IndexedDB for this table
}

export interface EligibleTablesResponsePayload {
  tables: EligibleTableInfo[];
  url: string;
}

export interface ScrollToTablePayload {
  xpath: string;
}

export type Message =
  | { type: 'EDIT_TABLE'; payload: EditTablePayload }
  | { type: 'ADD_COLUMN'; payload: AddColumnPayload }
  | { type: 'REMOVE_COLUMN'; payload: RemoveColumnPayload }
  | { type: 'REORDER_COLUMN'; payload: ReorderColumnPayload }
  | { type: 'EXTRACT_TABLE'; payload: ExtractTablePayload }
  | { type: 'INJECT_COLUMNS'; payload: InjectColumnsPayload }
  | { type: 'UPDATE_INSTANCE_OF'; payload: UpdateInstanceOfPayload }
  | { type: 'CONTEXT_MENU_ACTIVATED'; payload: ContextMenuActivatedPayload }
  | { type: 'HIGHLIGHT_NOT_FOUND_ON'; payload: HighlightNotFoundPayload }
  | { type: 'HIGHLIGHT_NOT_FOUND_OFF'; payload: { xpath: string } }
  | { type: 'OPEN_SIDEBAR' }
  | { type: 'GET_ELIGIBLE_TABLES' }
  | { type: 'ELIGIBLE_TABLES_RESPONSE'; payload: EligibleTablesResponsePayload }
  | { type: 'SCROLL_TO_TABLE'; payload: ScrollToTablePayload };

// ============================================================================
// UI State Types
// ============================================================================

export interface SidebarState {
  currentTable: TableRecord | null;
  columns: SidebarColumn[];
  isLoading: boolean;
  loadingMessage: string;
  matchedRows: RowMatch[];
  availableProperties: PropertyStats[];
}

export interface SidebarColumn {
  letter: string;
  index: number;
  header: string;
  isKey: boolean;
  isWikidata: boolean;
  propertyId?: string;
  position?: number; // Unique identifier for Wikidata columns
}
