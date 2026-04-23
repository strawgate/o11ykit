import { highlightExplorerEntry } from "./byte-explorer-highlight.js";

const MAX_BITS = 2048;
const BITS_PER_ROW = 64;

function buildBitLookup(bitMap) {
  const bitLookup = {};
  if (bitMap) {
    for (let mi = 0; mi < bitMap.length; mi++) {
      const entry = bitMap[mi];
      const baseOffset = (entry.blobOffset || 0) * 8;
      for (let b = entry.startBit; b < entry.endBit; b++) {
        bitLookup[baseOffset + b] = entry;
      }
    }
  }
  return bitLookup;
}

function renderBitGrid(container, bytes, regions, maxBits, bitLookup) {
  regions.forEach((region) => {
    const regionHeader = document.createElement("div");
    regionHeader.style.cssText = "margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;";
    regionHeader.textContent =
      "\u2500\u2500 " +
      region.name +
      " (bytes " +
      region.start +
      "\u2013" +
      (region.end - 1) +
      ") \u2500\u2500";
    container.appendChild(regionHeader);

    const regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    let prevEntry = null;

    for (let rowStart = 0; rowStart < regionBytes.length * 8; rowStart += BITS_PER_ROW) {
      const rowEl = document.createElement("div");
      rowEl.className = "bit-row";

      const label = document.createElement("span");
      label.className = "bit-sample-label";
      label.textContent = `b${region.start * 8 + rowStart}`;
      rowEl.appendChild(label);

      const rowEnd = Math.min(rowStart + BITS_PER_ROW, regionBytes.length * 8);
      for (let b = rowStart; b < rowEnd; b++) {
        const byteOff = Math.floor(b / 8);
        const bitOff = 7 - (b % 8);
        const bitVal = (regionBytes[byteOff] >> bitOff) & 1;

        const globalBitIdx = region.start * 8 + b;
        const bitEl = document.createElement("span");
        bitEl.className = `bit ${bitVal ? "b1" : "b0"}`;
        bitEl.textContent = bitVal;
        bitEl.dataset.bit = globalBitIdx;

        const mapEntry = bitLookup[globalBitIdx];
        if (mapEntry) {
          bitEl.classList.add("bit-mapped");
          bitEl.classList.add(mapEntry.type === "timestamp" ? "bit-ts" : "bit-val");
          bitEl.classList.add(
            mapEntry.sampleIndex % 2 === 0 ? "bit-sample-even" : "bit-sample-odd"
          );
          if (mapEntry !== prevEntry && prevEntry !== null) {
            bitEl.classList.add("bit-boundary");
          }
          if (prevEntry === null) {
            bitEl.classList.add("bit-boundary");
          }
          bitEl.title =
            (mapEntry.type === "timestamp" ? "\u23f1 " : "\uD83D\uDCCA ") +
            "Sample #" +
            mapEntry.sampleIndex;
          prevEntry = mapEntry;
        }

        rowEl.appendChild(bitEl);

        if ((b + 1) % 8 === 0 && b + 1 < rowEnd) {
          const sep = document.createElement("span");
          sep.style.cssText = "width:4px;";
          rowEl.appendChild(sep);
        }
      }

      container.appendChild(rowEl);
    }

    if (region.end * 8 > maxBits) return;
  });

  if (bytes.length * 8 > maxBits) {
    const note = document.createElement("div");
    note.style.cssText = "margin-top:8px;color:#94a3b8;font-size:10px;";
    note.textContent = `Showing first ${maxBits} of ${bytes.length * 8} bits...`;
    container.appendChild(note);
  }
}

function setupBitInteraction(container, bitLookup, explorer) {
  const decodePanel = document.createElement("div");
  decodePanel.className = "bit-decode-panel";
  decodePanel.style.display = "none";

  function highlightBitRange(entry) {
    highlightExplorerEntry({
      entry,
      decodePanel,
      emptyKind: decodePanel.id === "hexDecodePanelTs" ? "timestamp" : "byte",
      clearHighlights() {
        container.querySelectorAll(".bit.bit-highlight").forEach((el) => {
          el.classList.remove("bit-highlight", "bit-highlight-ts", "bit-highlight-val");
        });
      },
      applyHighlight(e) {
        const baseOffset = (e.blobOffset || 0) * 8;
        for (let b = e.startBit; b < e.endBit; b++) {
          const globalBit = baseOffset + b;
          const el = container.querySelector(`.bit[data-bit="${globalBit}"]`);
          if (el) {
            el.classList.add("bit-highlight");
            el.classList.add(e.type === "timestamp" ? "bit-highlight-ts" : "bit-highlight-val");
          }
        }
        const bits = e.endBit - e.startBit;
        return `${bits} bits (bit ${e.startBit}\u2013${e.endBit - 1})`;
      },
      setActiveEntry() {},
    });
  }

  container.addEventListener("click", (e) => {
    const bitEl = e.target.closest(".bit-mapped");
    if (!bitEl) {
      highlightBitRange(null);
      return;
    }
    const globalBit = parseInt(bitEl.dataset.bit, 10);
    const entry = bitLookup[globalBit];
    if (entry) highlightBitRange(entry);
  });

  container.addEventListener("mouseover", (e) => {
    const bitEl = e.target.closest(".bit-mapped");
    if (bitEl) bitEl.classList.add("bit-hover");
  });
  container.addEventListener("mouseout", (e) => {
    const bitEl = e.target.closest(".bit-mapped");
    if (bitEl) bitEl.classList.remove("bit-hover");
  });

  const keyAbort = new AbortController();
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") highlightBitRange(null);
    },
    { signal: keyAbort.signal }
  );
  container.addEventListener("remove", () => keyAbort.abort());
  const keyCleanupObserver = new MutationObserver(() => {
    if (!container.isConnected) {
      keyAbort.abort();
      keyCleanupObserver.disconnect();
    }
  });
  keyCleanupObserver.observe(document.body, { childList: true, subtree: true });

  explorer.querySelector(".hex-decode-panel").after(decodePanel);
  explorer.querySelector(".hex-decode-panel").after(container);
}

export function renderBitView(explorer, bytes, regions, bitMap) {
  const scrollContainer = explorer.querySelector(".hex-grid-scroll");
  scrollContainer.style.display = "none";

  const existing = explorer.querySelector(".bit-view");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.className = "bit-view";

  const maxBits = Math.min(bytes.length * 8, MAX_BITS);
  const bitLookup = buildBitLookup(bitMap);

  renderBitGrid(container, bytes, regions, maxBits, bitLookup);
  setupBitInteraction(container, bitLookup, explorer);
}
