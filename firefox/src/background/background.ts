// WikiColumn - Background Service Worker

import type { Message, EditTablePayload, TableData } from '../lib/types';

const CONTEXT_MENU_ID = 'wikicolumn-edit-table';

// Create context menu on install
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Edit with WikiColumn',
    contexts: ['page', 'selection'],
  });
});

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;

  try {
    // Send message to content script to extract table
    const response = await browser.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_TABLE',
      payload: {},
    });

    if (response && response.tableData) {
      // Open sidebar
      await browser.sidebarAction.open();

      // Small delay to ensure sidebar is ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Forward table data to sidebar
      const editTablePayload: EditTablePayload = {
        tableData: response.tableData as TableData,
        url: tab.url || '',
        tabId: tab.id,
      };

      await browser.runtime.sendMessage({
        type: 'EDIT_TABLE',
        payload: editTablePayload,
      });
    } else if (response && response.error) {
      console.warn('WikiColumn: No table found -', response.error);
    }
  } catch (error) {
    console.error('WikiColumn: Error handling context menu click:', error);
  }
});

// Handle messages from content script and sidebar
browser.runtime.onMessage.addListener(
  (message: Message, _sender, _sendResponse) => {
    // Route messages based on type
    switch (message.type) {
      case 'EDIT_TABLE':
        // Forward to sidebar (sidebar listens for this)
        // The message is already being sent via runtime.sendMessage
        break;

      case 'ADD_COLUMN':
      case 'REMOVE_COLUMN':
      case 'REORDER_COLUMN':
      case 'INJECT_COLUMNS':
        // Forward to content script in the relevant tab
        if ('tabId' in message.payload) {
          const tabId = (message.payload as { tabId: number }).tabId;
          browser.tabs.sendMessage(tabId, message).catch((error) => {
            console.error('WikiColumn: Error forwarding message to tab:', error);
          });
        }
        break;

      case 'OPEN_SIDEBAR':
        browser.sidebarAction.open();
        break;
    }

    // Return true to indicate async response (even if we don't use it)
    return true;
  }
);

// Handle toolbar button click - toggle sidebar
browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

console.log('WikiColumn background script loaded');
