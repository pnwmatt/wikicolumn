/**
 * Utility functions
 */

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get XPath for a DOM node
 * For text nodes, returns path to parent element with text() index
 */
export function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) {
    return '/';
  }

  const parent = node.parentNode;
  if (!parent) {
    return '';
  }

  // For text nodes, get parent path and add text() selector
  if (node.nodeType === Node.TEXT_NODE) {
    const parentPath = getXPath(parent);
    const textNodes = Array.from(parent.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE
    );
    const textIndex = textNodes.indexOf(node as ChildNode) + 1;
    return `${parentPath}/text()[${textIndex}]`;
  }

  const parentPath = getXPath(parent);
  const siblings = Array.from(parent.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName === node.nodeName
  );
  const index = siblings.indexOf(node as ChildNode) + 1;

  const nodeName = node.nodeName.toLowerCase();
  return `${parentPath}/${nodeName}[${index}]`;
}

/**
 * Get a node from an XPath
 */
export function getNodeFromXPath(xpath: string, doc: Document = document): Node | null {
  try {
    const result = doc.evaluate(
      xpath,
      doc,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  } catch (error) {
    console.error('Failed to evaluate XPath:', error);
    return null;
  }
}

/**
 * Format date for display
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}
