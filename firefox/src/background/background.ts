// WikiColumn - Background Service Worker

import type { Message } from '../lib/types';

const CONTEXT_MENU_ID = 'wikicolumn-edit-table';

// Create context menu on install
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Edit with WikiColumn',
    contexts: ['page', 'selection', 'link',],
  });
});

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;

  console.log('WikiColumn: Context menu clicked, opening sidebar...');

  // IMPORTANT: Open sidebar FIRST, synchronously, before any async operations
  // Firefox requires sidebarAction.open() to be called directly in user action handler
  await browser.sidebarAction.open(); console.log('Sidebar opened');

  // Tell content script to extract and send the table data
  // Content script already captured the right-clicked element via contextmenu listener
  browser.tabs.sendMessage(tab.id, {
    type: 'CONTEXT_MENU_ACTIVATED',
    payload: { url: tab.url || '', tabId: tab.id },
  }).catch((error) => {
    console.error('WikiColumn: Error sending CONTEXT_MENU_ACTIVATED:', error);
  });
  return true;
});

// Handle messages from content script and sidebar
browser.runtime.onMessage.addListener(
  async (message: Message, _sender, _sendResponse) => {
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
