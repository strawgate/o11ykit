import { buildEmptyDecodeHTML, buildEntryDecodeHTML } from "./byte-explorer-presenter.js";

export function highlightExplorerEntry({
  entry,
  decodePanel,
  emptyKind,
  clearHighlights,
  applyHighlight,
  setActiveEntry,
}) {
  clearHighlights();
  if (!entry) {
    decodePanel.style.display = "";
    decodePanel.innerHTML = buildEmptyDecodeHTML(emptyKind);
    setActiveEntry(null);
    return;
  }
  setActiveEntry(entry);
  const spanDesc = applyHighlight(entry);
  decodePanel.style.display = "";
  decodePanel.innerHTML = buildEntryDecodeHTML(entry, spanDesc);
}
