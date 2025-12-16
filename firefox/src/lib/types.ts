// Core data types for Webtero


export interface MagicTable {

}

// Message types for extension communication
export type MessageType =
  | 'GET_PAGE_DATA'
  | 'SAVE_PAGE';

export interface Message {
  type: MessageType;
  data?: unknown;
}
