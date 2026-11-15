import { useState, useRef, useEffect } from 'react';
import { detectPage, warmUpDetection } from './bubbles.js';
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js';
const { ipcRenderer } = window.require ? window.require('electron') : {};

const SIDEBAR_WIDTH = 560; // px
const ZOOM_MARGIN = 12; // px an enlarged panel or bubble keeps from the viewer's edges

// View modes: magnifier lens, panel-by-panel zoom (Marvel Unlimited style),
// or bubble-by-bubble zoom (Google Play Books style)
const VIEW_MODES = [
  { id: 'lens', label: 'Lens', icon: '🔍', key: 'L', title: 'Magnifying lens follows the mouse (L)' },
  { id: 'panel', label: 'Panel', icon: '🖼️', key: 'P', title: 'Zoom into each panel in reading order (P)' },
  { id: 'bubble', label: 'Bubble', icon: '💬', key: 'B', title: 'Enlarge each speech bubble in reading order (B)' },
];

// Fit the page inside the viewer (never upscaling), centred
function fitPage(viewer, page) {
  const scale = Math.min(viewer.width / page.width, viewer.height / page.height, 1);
  return {
    scale,
    tx: (viewer.width - page.width * scale) / 2,
    ty: (viewer.height - page.height * scale) / 2,
  };
}

// A panel's or bubble's rect (normalised to the page) in viewer pixels
function bubbleRect(page, layout, bubble) {
  return {
    left: layout.tx + bubble.x * page.width * layout.scale,
    top: layout.ty + bubble.y * page.height * layout.scale,
    width: bubble.w * page.width * layout.scale,
    height: bubble.h * page.height * layout.scale,
  };
}

// Index of the smallest bubble containing viewer point (x, y), or -1
function bubbleAt(page, layout, bubbles, x, y) {
  const px = (x - layout.tx) / (page.width * layout.scale);
  const py = (y - layout.ty) / (page.height * layout.scale);
  let hit = -1;
  bubbles.forEach((b, i) => {
    const inside = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    if (inside && (hit < 0 || b.w * b.h < bubbles[hit].w * bubbles[hit].h)) hit = i;
  });
  return hit;
}

// A panel grown to take in the bubbles that belong to it (centred inside it) but poke out
// over its border, so zooming the panel doesn't cut them off
function withBubbles(panel, bubbles = []) {
  let x0 = panel.x, y0 = panel.y, x1 = panel.x + panel.w, y1 = panel.y + panel.h;
  for (const b of bubbles) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (cx < panel.x || cx > panel.x + panel.w || cy < panel.y || cy > panel.y + panel.h) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Place an enlarged copy of a panel or bubble (rect normalised to the page) over its spot on the page
function popOutZoom(viewer, page, layout, bubble, zoom) {
  const { left: bx, top: by, width: bw, height: bh } = bubbleRect(page, layout, bubble);
  const z = Math.max(1, Math.min(
    zoom,
    (viewer.width - 2 * ZOOM_MARGIN) / bw,
    (viewer.height - 2 * ZOOM_MARGIN) / bh,
  ));
  const width = bw * z, height = bh * z;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const left = clamp(bx + bw / 2 - width / 2, ZOOM_MARGIN, viewer.width - width - ZOOM_MARGIN);
  const top = clamp(by + bh / 2 - height / 2, ZOOM_MARGIN, viewer.height - height - ZOOM_MARGIN);
  return {
    left, top, width, height,
    // The page image inside, scaled so the rect's area lines up with the box
    imageLeft: -bubble.x * page.width * layout.scale * z,
    imageTop: -bubble.y * page.height * layout.scale * z,
    imageWidth: page.width * layout.scale * z,
    imageHeight: page.height * layout.scale * z,
    // Animation start: shrunk back onto its original spot
    popFrom: `translate(${bx + bw / 2 - (left + width / 2)}px, ${by + bh / 2 - (top + height / 2)}px) scale(${1 / z})`,
  };
}

// CSS that clips an element to a bubble's shape (mask PNG stretched over the bubble's rect)
function shapeMask(maskUrl) {
  if (!maskUrl) return { borderRadius: 10 };
  const mask = `url("${maskUrl}")`;
  return {
    WebkitMaskImage: mask, maskImage: mask,
    WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
    WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
  };
}

// A setting remembered across sessions (falls back to `initial` if storage is unavailable)
function useStoredSetting(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
  }, [key, value]);
  return [value, setValue];
}

// e.g. "Bubble 2 of 7", "Full page · 7 panels"
function zoomStatus(items, active, noun) {
  if (!items) return `finding ${noun}s…`;
  if (items.length === 0) return `no ${noun}s found`;
  if (active === null) return `Full page · ${items.length} ${noun}${items.length === 1 ? '' : 's'}`;
  return `${noun[0].toUpperCase()}${noun.slice(1)} ${active + 1} of ${items.length}`;
}

export default function App() {
  const [pages, setPages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentFile, setCurrentFile] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);

  // Lens settings (default: rectangle, 400px, 2x zoom)
  const [shape, setShape] = useStoredSetting('lensShape', 'rectangle');
  const [size, setSize] = useStoredSetting('lensSize', 400);
  const [zoomLevel, setZoomLevel] = useStoredSetting('lensZoom', 2);

  // UI State
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [gearTurns, setGearTurns] = useState(0); // half-turns the settings gear has rolled

  // Panel / Bubble View: zoom to one panel or speech bubble at a time, in reading order
  const [viewMode, setViewMode] = useStoredSetting('viewMode', 'lens'); // 'lens' | 'panel' | 'bubble'
  const panelMode = viewMode === 'panel';
  const bubbleMode = viewMode === 'bubble';
  const [fullPageFirst, setFullPageFirst] = useStoredSetting('fullPageFirst', true); // show the whole page before zooming in
  const [fullPageAfter, setFullPageAfter] = useStoredSetting('fullPageAfter', false); // and again after the last panel/bubble
  const [bubbleZoomLevel, setBubbleZoomLevel] = useStoredSetting('bubbleZoom', 2.5); // how much an active bubble is enlarged
  const [panelZoomLevel, setPanelZoomLevel] = useStoredSetting('panelZoom', 2); // ...and an active panel (both capped to fit the viewer)
  // null = whole page before, a panel/bubble index, 'last', or 'after' = whole page after the last one
  const [step, setStep] = useState(null);
  const [detectedByPage, setDetectedByPage] = useState({}); // page URL -> { panels, bubbles }
  const [hoverBubble, setHoverBubble] = useState(-1); // bubble under the mouse in Bubble View
  const requestedPages = useRef(new Set());
  const detecting = useRef(false); // a page is being detected (one at a time)
  const [detectionTick, setDetectionTick] = useState(0); // bumps when one finishes, to start the next

  // Manga: read right-to-left (panels and bubbles), optionally with ← as "forward"
  const [theme, setTheme] = useStoredSetting('theme', DEFAULT_THEME);
  useEffect(() => applyTheme(theme), [theme]);

  const [mangaMode, setMangaMode] = useStoredSetting('mangaMode', false);
  const [swapArrows, setSwapArrows] = useStoredSetting('mangaSwapArrows', true);
  const leftIsForward = mangaMode && swapArrows;
  const comicGeneration = useRef(0); // bumps per opened comic so stale detections are ignored

  // Geometry for positioning the page image
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 });
  const [pageSize, setPageSize] = useState(null); // { src, width, height } natural size of the shown page
  const viewerRef = useRef(null);

  const [lensData, setLensData] = useState({ show: false, clientX: 0, clientY: 0, bgX: 0, bgY: 0, bgWidth: 0, bgHeight: 0 });
  const imageRef = useRef(null);

  // Mouse clicks shouldn't leave buttons/bookmark rows focused: a focused row makes
  // later key presses (B, Enter, Space) look like they act on it. Keyboard-triggered
  // clicks (detail 0) keep focus so keyboard navigation still works.
  useEffect(() => {
    const releaseFocus = (e) => {
      const el = document.activeElement;
      if (e.detail > 0 && el?.matches('button, [role="button"]')) el.blur();
    };
    // Same for settings adjusted with the mouse: a focused slider would also take the
    // arrow keys, changing the setting as well as turning the page
    const releaseControl = () => {
      const el = document.activeElement;
      if (el?.matches('input[type="range"], input[type="checkbox"]')) el.blur();
    };
    const releaseSelect = (e) => {
      if (e.target.matches('select')) e.target.blur();
    };
    window.addEventListener('click', releaseFocus);
    window.addEventListener('pointerup', releaseControl);
    window.addEventListener('change', releaseSelect);
    return () => {
      window.removeEventListener('click', releaseFocus);
      window.removeEventListener('pointerup', releaseControl);
      window.removeEventListener('change', releaseSelect);
    };
  }, []);

  // Load saved bookmarks on startup, and the detection models in the background
  useEffect(() => {
    ipcRenderer?.invoke('bookmarks-get').then(setBookmarks);
    warmUpDetection();
  }, []);

  // Record the current page whenever it changes, so reading can resume later
  useEffect(() => {
    if (!ipcRenderer || !currentFile || pages.length === 0) return;
    ipcRenderer
      .invoke('bookmarks-save', { filePath: currentFile, lastPage: currentIndex, totalPages: pages.length })
      .then(setBookmarks);
  }, [currentFile, currentIndex, pages.length]);

  // Shared loader: `channel` is the IPC handler, `args` its arguments
  const loadComic = async (channel, ...args) => {
    if (!ipcRenderer) {
      alert("Electron IPC not available.");
      return;
    }
    
    setIsLoading(true);
    setLensData(prev => ({ ...prev, show: false }));

    try {
      const result = await ipcRenderer.invoke(channel, ...args);
      if (result && result.pages.length > 0) {
        const saved = bookmarks.find(b => b.filePath === result.filePath);
        const resumePage = saved ? Math.min(saved.lastPage, result.pages.length - 1) : 0;
        comicGeneration.current++;
        requestedPages.current = new Set();
        setDetectedByPage({});
        setStep(fullPageFirst ? null : 0);
        setPages(result.pages);
        setCurrentFile(result.filePath);
        setCurrentIndex(resumePage);
      } else if (channel === 'open-comic-path') {
        alert("Could not open this comic. The file may have been moved or deleted.");
        ipcRenderer.invoke('bookmarks-get').then(setBookmarks);
      }
    } catch (error) {
      console.error("Error loading comic:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenComic = () => loadComic('open-comic-file');
  const handleOpenBookmark = (filePath) => loadComic('open-comic-path', filePath);

  const handleRemoveBookmark = async (e, filePath) => {
    e.stopPropagation();
    setBookmarks(await ipcRenderer.invoke('bookmarks-remove', filePath));
  };

  // Detect panels and bubbles for the whole comic in the background, one page at a time: the
  // page on screen first, then the pages after it, then the ones before (nearest first). Each
  // finished page (or page turn) picks the next, so a jump waits behind at most one page.
  useEffect(() => {
    if (pages.length === 0 || detecting.current) return;
    const order = [currentIndex];
    for (let i = currentIndex + 1; i < pages.length; i++) order.push(i);
    for (let i = currentIndex - 1; i >= 0; i--) order.push(i);
    const next = order.find(i => !requestedPages.current.has(pages[i]));
    if (next === undefined) return;

    const url = pages[next];
    const generation = comicGeneration.current;
    requestedPages.current.add(url);
    detecting.current = true;
    // Manga mode picks both the reading order and the manga panel detector
    detectPage(url, { rtl: mangaMode, style: mangaMode ? 'manga' : 'comic', current: next === currentIndex })
      .catch((error) => {
        console.error("Panel/bubble detection failed:", error);
        return { panels: [], bubbles: [] };
      })
      .then((detected) => {
        detecting.current = false;
        if (comicGeneration.current === generation) {
          setDetectedByPage(prev => ({ ...prev, [url]: detected }));
        }
        setDetectionTick(t => t + 1); // pick the next page, even if this one was for another comic
      });
  }, [mangaMode, pages, currentIndex, detectionTick]);

  // Track the viewer's size so the page can be fitted to it
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pageUrl = pages[currentIndex];
  const detected = detectedByPage[pageUrl];
  const pagesDetected = pages.reduce((n, url) => n + (detectedByPage[url] ? 1 : 0), 0);
  const pageBubbles = detected?.bubbles;
  // A page without gutters is one full-page "panel": nothing to zoom into
  const pagePanels = detected && detected.panels.filter(p => p.w * p.h < 0.9);
  const items = bubbleMode ? pageBubbles : panelMode ? pagePanels : null; // what the arrows step through
  const noun = bubbleMode ? 'bubble' : 'panel';
  const activeIndex = items?.length > 0 && step !== null && step !== 'after'
    ? (step === 'last' ? items.length - 1 : Math.min(step, items.length - 1))
    : null;
  const activeBubble = bubbleMode ? activeIndex : null;
  const activePanel = panelMode ? activeIndex : null;
  const pageReady = pageSize && pageSize.src === pageUrl && viewerSize.width > 0;
  const layout = pageReady ? fitPage(viewerSize, pageSize) : null;
  const zoomBox = !layout ? null
    : activeBubble !== null ? popOutZoom(viewerSize, pageSize, layout, pageBubbles[activeBubble], bubbleZoomLevel)
    : activePanel !== null ? popOutZoom(viewerSize, pageSize, layout, withBubbles(pagePanels[activePanel], pageBubbles), panelZoomLevel)
    : null;

  const turnPage = (delta) => {
    const next = currentIndex + delta;
    if (next < 0 || next >= pages.length) return;
    setHoverBubble(-1);
    setCurrentIndex(next);
    if (delta > 0) setStep(fullPageFirst ? null : 0);
    else setStep(fullPageAfter ? 'after' : 'last');
  };

  const goNext = () => {
    if (items?.length > 0 && step !== 'after') {
      if (step === null) return setStep(0);
      if (activeIndex < items.length - 1) return setStep(activeIndex + 1);
      if (fullPageAfter) return setStep('after');
    }
    turnPage(1);
  };

  const goPrev = () => {
    if (step === 'after' && items?.length > 0) return setStep('last');
    if (activeIndex !== null) {
      if (activeIndex > 0) return setStep(activeIndex - 1);
      if (fullPageFirst) return setStep(null);
    }
    turnPage(-1);
  };

  const toggleMangaMode = (on) => {
    comicGeneration.current++; // results in the old order are discarded
    requestedPages.current = new Set();
    setDetectedByPage({});
    setStep(fullPageFirst ? null : 0);
    setMangaMode(on);
  };

  const switchViewMode = (mode) => {
    setHoverBubble(-1);
    setViewMode(mode);
    setStep(fullPageFirst ? null : 0);
    setLensData(prev => ({ ...prev, show: false }));
  };
  // P / B toggle their mode on and off (back to the lens)
  const toggleViewMode = (mode) => switchViewMode(viewMode === mode ? 'lens' : mode);

  // Re-subscribed every render so the handler always sees current state
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (pages.length === 0) return;
      if (['INPUT', 'SELECT'].includes(e.target.tagName)) return; // let sliders/dropdowns keep their keys
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const forward = (e.key === 'ArrowLeft') === leftIsForward;
        if (forward) goNext();
        else goPrev();
      } else if (e.key === 'b' || e.key === 'B') {
        toggleViewMode('bubble');
      } else if (e.key === 'p' || e.key === 'P') {
        toggleViewMode('panel');
      } else if (e.key === 'l' || e.key === 'L' || (e.key === 'Escape' && viewMode !== 'lens')) {
        switchViewMode('lens');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleMouseMove = (e) => {
    if (isLoading) return;
    if (panelMode) return; // no lens while zooming panels
    if (bubbleMode) {
      // Plain cursor in Bubble View: highlight the bubble under it so it can be clicked
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const overZoom = zoomBox && x >= zoomBox.left && x <= zoomBox.left + zoomBox.width &&
        y >= zoomBox.top && y <= zoomBox.top + zoomBox.height;
      const hit = layout && pageBubbles?.length > 0 && !overZoom
        ? bubbleAt(pageSize, layout, pageBubbles, x, y)
        : -1;
      if (hit !== hoverBubble) setHoverBubble(hit);
      return;
    }
    const img = imageRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
      const bgWidth = rect.width * zoomLevel;
      const bgHeight = rect.height * zoomLevel;

      const xPercent = x / rect.width;
      const yPercent = y / rect.height;

      const bgX = -(xPercent * bgWidth - size / 2);
      const bgY = -(yPercent * bgHeight - (shape === 'rectangle' ? (size * 0.75) / 2 : size / 2));

      setLensData({ show: true, clientX: e.clientX, clientY: e.clientY, bgX, bgY, bgWidth, bgHeight });
    } else {
      setLensData((prev) => ({ ...prev, show: false }));
    }
  };

  const handleViewerClick = (e) => {
    if (pages.length === 0 || isLoading) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (bubbleMode && layout && pageBubbles?.length > 0) {
      // Clicking the enlarged bubble does nothing; clicking a bubble on the page jumps to it
      if (zoomBox && clickX >= zoomBox.left && clickX <= zoomBox.left + zoomBox.width &&
          clickY >= zoomBox.top && clickY <= zoomBox.top + zoomBox.height) return;
      const hit = bubbleAt(pageSize, layout, pageBubbles, clickX, clickY);
      if (hit >= 0) return setStep(hit);
    }

    const clickedLeft = clickX < rect.width / 2;
    if (clickedLeft === leftIsForward) goNext();
    else goPrev();
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', backgroundColor: '#000', color: '#fff', userSelect: 'none', overflow: 'hidden' }}>

      {/* Collapsible Sidebar Wrapper */}
      <div style={{ display: 'flex', zIndex: 20, height: '100%', position: 'relative' }}>
        
        {/* Sidebar Content Panel */}
        <div
          style={{
            width: isSidebarOpen ? SIDEBAR_WIDTH : 0,
            opacity: isSidebarOpen ? 1 : 0,
            transition: 'width 0.25s ease-in-out, opacity 0.2s ease-in-out',
            overflow: 'hidden',
            flexShrink: 0,
            height: '100%'
          }}
          className="bg-gray-900 border-r border-gray-800"
        >
          <div style={{ width: SIDEBAR_WIDTH }} className="flex flex-col h-full">

            {/* Header: title, current comic, open button */}
            <div className="p-5 pb-4 border-b border-gray-800 shrink-0">
              <h1 className="text-lg font-bold text-accent-400 tracking-tight">Comic Glass Reader</h1>
              {currentFile && pages.length > 0 ? (
                <div className="mt-2 mb-4">
                  <p className="text-sm text-gray-200 truncate" title={currentFile}>
                    {bookmarks.find(b => b.filePath === currentFile)?.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Page {currentIndex + 1} of {pages.length}
                    {viewMode !== 'lens' && ` · ${zoomStatus(items, activeIndex, noun)}`}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    Click sides or <kbd className="bg-gray-800 px-1 rounded text-gray-300">←</kbd> <kbd className="bg-gray-800 px-1 rounded text-gray-300">→</kbd> to {viewMode !== 'lens' ? `step through ${noun}s` : 'turn pages'}{leftIsForward && ' (← is forward)'}
                  </p>
                  {/* Background detection of every page, so Panel/Bubble View page turns are instant */}
                  <div
                    className="flex items-center gap-2 mt-2"
                    title="Panels and bubbles are found for every page in the background, starting with the page on screen"
                  >
                    {pagesDetected < pages.length ? (
                      <>
                        <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-accent-500 rounded-full transition-[width] duration-300" style={{ width: `${(pagesDetected / pages.length) * 100}%` }} />
                        </div>
                        <span className="shrink-0 text-[11px] text-gray-500 tabular-nums">Finding bubbles · {pagesDetected} / {pages.length} pages</span>
                      </>
                    ) : (
                      <span className="text-[11px] text-gray-500">✓ Bubbles ready on all {pages.length} pages</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-500 mt-2 mb-4">Open a comic to start reading.</p>
              )}
              <button
                onClick={handleOpenComic}
                disabled={isLoading}
                className="w-full bg-accent-600 hover:bg-accent-500 text-accent-on disabled:opacity-50 py-2 px-4 rounded-md font-medium transition shadow cursor-pointer text-sm"
              >
                📁 Browse Comic (.cbz, .cbr)
              </button>
              {/* View mode: one of Lens / Panel / Bubble */}
              <div className="grid grid-cols-3 gap-2 mt-2">
                {VIEW_MODES.map(m => (
                  <button
                    key={m.id}
                    onClick={() => switchViewMode(m.id)}
                    disabled={pages.length === 0}
                    title={m.title}
                    className={`py-2 px-3 rounded-md text-sm font-medium transition cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center justify-between border ${
                      viewMode === m.id ? 'bg-accent-950/60 border-accent-600 text-accent-200' : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    <span>{m.icon} {m.label}</span>
                    <kbd className="bg-gray-900 px-1.5 rounded text-xs text-gray-400">{m.key}</kbd>
                  </button>
                ))}
              </div>
            </div>

            {/* Bookmarks: the only part of the sidebar that scrolls */}
            <div className="flex-1 min-h-0 flex flex-col pt-4">
              <div className="px-5 mb-2 flex items-baseline justify-between">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Recently Read</h2>
                {bookmarks.length > 0 && <span className="text-xs text-gray-600">{bookmarks.length}</span>}
              </div>
              {bookmarks.length === 0 ? (
                <p className="px-5 text-xs text-gray-600">Comics you open will appear here, with your last page saved.</p>
              ) : (
                <ul className="flex-1 min-h-0 overflow-y-auto px-3 pb-8 space-y-1">
                  {bookmarks.map((b) => {
                    const isCurrent = b.filePath === currentFile;
                    const progress = b.totalPages > 0 ? ((b.lastPage + 1) / b.totalPages) * 100 : 0;
                    return (
                      <li key={b.filePath}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => !isLoading && handleOpenBookmark(b.filePath)}
                          onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleOpenBookmark(b.filePath)}
                          title={b.filePath}
                          className={`group rounded-md px-2 py-2 cursor-pointer transition border ${
                            isCurrent ? 'bg-accent-950/60 border-accent-800' : 'border-transparent hover:bg-gray-800'
                          } ${b.missing ? 'opacity-50' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <p className={`flex-1 min-w-0 text-sm truncate ${isCurrent ? 'text-accent-200' : 'text-gray-200'}`}>{b.name}</p>
                            <button
                              onClick={(e) => handleRemoveBookmark(e, b.filePath)}
                              className="shrink-0 text-gray-500 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition cursor-pointer"
                              title="Remove bookmark"
                            >
                              ✕
                            </button>
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div className="h-full bg-accent-500 rounded-full" style={{ width: `${progress}%` }} />
                            </div>
                            <span className="shrink-0 text-[11px] text-gray-500 tabular-nums">
                              {b.missing ? 'File not found' : `${b.lastPage + 1} / ${b.totalPages}`}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Settings drawer: slides up from the bottom; the gear tab on its top edge toggles it */}
            <div className="relative shrink-0 border-t border-gray-800">
              <button
                onClick={() => {
                  setIsSettingsOpen(open => !open);
                  setGearTurns(turns => turns + 1);
                }}
                className="absolute left-1/2 bottom-full -translate-x-1/2 bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-white border-t border-l border-r border-gray-800 flex items-center justify-center cursor-pointer transition-colors"
                style={{ width: 60, height: 20, borderTopLeftRadius: 6, borderTopRightRadius: 6, marginBottom: 1 }}
                title={isSettingsOpen ? 'Hide settings' : 'Show settings'}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: `rotate(${gearTurns * 180}deg)`, transition: 'transform 0.5s cubic-bezier(0.34, 1.4, 0.64, 1)' }}
                >
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>

              <div
                style={{
                  // At most ~half the window, so Recently Read stays usable; scrolls when taller
                  maxHeight: isSettingsOpen ? 'min(560px, 55vh)' : 0,
                  opacity: isSettingsOpen ? 1 : 0,
                  overflowX: 'hidden',
                  overflowY: isSettingsOpen ? 'auto' : 'hidden',
                  transition: 'max-height 0.3s ease-in-out, opacity 0.2s ease-in-out'
                }}
              >
                <div className="p-5 pt-4 space-y-5">
                  {/* Theme and Reading: centred blocks across the pane */}
                  <div className="w-fit mx-auto space-y-3">
                    <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-center">Theme</h2>
                    <div className="flex items-center gap-2.5">
                      {Object.entries(THEMES).map(([name, t]) => (
                        <button
                          key={name}
                          onClick={() => setTheme(name)}
                          title={t.label}
                          className="w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110"
                          style={{
                            backgroundColor: `rgb(${t[500]})`,
                            boxShadow: theme === name ? `0 0 0 2px rgb(17 24 39), 0 0 0 4px rgb(${t[400]})` : 'none'
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="w-fit mx-auto space-y-3">
                    <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-center">Reading</h2>
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mangaMode}
                        onChange={(e) => toggleMangaMode(e.target.checked)}
                        className="accent-accent-500 cursor-pointer"
                      />
                      Manga mode (read right to left)
                    </label>
                    <label className={`flex items-center gap-2 text-xs pl-6 ${mangaMode ? 'text-gray-300 cursor-pointer' : 'text-gray-600'}`}>
                      <input
                        type="checkbox"
                        checked={swapArrows}
                        disabled={!mangaMode}
                        onChange={(e) => setSwapArrows(e.target.checked)}
                        className="accent-accent-500 cursor-pointer disabled:cursor-default"
                      />
                      Swap ← / → (← and left click go forward)
                    </label>
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={fullPageFirst}
                        onChange={(e) => setFullPageFirst(e.target.checked)}
                        className="accent-accent-500 cursor-pointer"
                      />
                      Show full page before zooming into panels / bubbles
                    </label>
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={fullPageAfter}
                        onChange={(e) => setFullPageAfter(e.target.checked)}
                        className="accent-accent-500 cursor-pointer"
                      />
                      Show full page after the last panel / bubble
                    </label>
                  </div>

                  {/* Lens | Panel / Bubble View side by side; the latter centred vertically beside Lens */}
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-3 min-w-0">
                      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Lens</h2>
                      <div>
                        <label className="text-xs text-gray-300 block mb-1">Lens Shape</label>
                        <select value={shape} onChange={(e) => setShape(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-md p-1.5 text-sm cursor-pointer">
                          <option value="rectangle">Rectangle</option>
                          <option value="circle">Circle</option>
                          <option value="square">Square</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-300 flex justify-between mb-1"><span>Lens Size</span><span className="text-gray-500">{size}px</span></label>
                        <input
                          type="range"
                          min="200"
                          max="1000"
                          value={size}
                          onChange={(e) => setSize(Number(e.target.value))}
                          className="w-full accent-accent-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-300 flex justify-between mb-1"><span>Lens Zoom</span><span className="text-gray-500">{zoomLevel}x</span></label>
                        <input type="range" min="1.5" max="4" step="0.5" value={zoomLevel} onChange={(e) => setZoomLevel(Number(e.target.value))} className="w-full accent-accent-500 cursor-pointer" />
                      </div>
                    </div>
                    <div className="space-y-3 min-w-0 self-center">
                      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Panel / Bubble View</h2>
                      <div>
                        <label className="text-xs text-gray-300 flex justify-between mb-1"><span>Panel Zoom</span><span className="text-gray-500">{panelZoomLevel}x</span></label>
                        <input type="range" min="1.25" max="4" step="0.25" value={panelZoomLevel} onChange={(e) => setPanelZoomLevel(Number(e.target.value))} className="w-full accent-accent-500 cursor-pointer" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-300 flex justify-between mb-1"><span>Bubble Zoom</span><span className="text-gray-500">{bubbleZoomLevel}x</span></label>
                        <input type="range" min="1.5" max="5" step="0.25" value={bubbleZoomLevel} onChange={(e) => setBubbleZoomLevel(Number(e.target.value))} className="w-full accent-accent-500 cursor-pointer" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Toggle Column Arrow */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-white border-r border-b border-t border-gray-800 flex items-center justify-center cursor-pointer transition-colors"
          style={{
            width: '20px',
            height: '60px',
            position: 'absolute',
            left: isSidebarOpen ? SIDEBAR_WIDTH : 0,
            top: '50%',
            transform: 'translateY(-50%)',
            transition: 'left 0.25s ease-in-out',
            borderTopRightRadius: '6px',
            borderBottomRightRadius: '6px',
            zIndex: 30,
            outline: 'none'
          }}
          title={isSidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}
        >
          <span style={{ fontSize: '10px' }}>{isSidebarOpen ? '◀' : '▶'}</span>
        </button>
      </div>

      {/* Main Full-Height Container Area */}
      <div style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', overflow: 'hidden' }}>

        {/* Loading Overlay */}
        {isLoading && (
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.85)', zIndex: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div className="w-10 h-10 border-4 border-accent-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-accent-300 font-medium text-sm">Extracting and loading comic pages...</p>
          </div>
        )}

        {/* Viewer Area */}
        <div
          style={{ 
            flex: 1, 
            width: '100%', 
            height: '100%', 
            position: 'relative', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            overflow: 'hidden', 
            padding: '0', 
            cursor: bubbleMode ? (hoverBubble >= 0 ? 'pointer' : 'default') : panelMode ? 'default' : (lensData.show ? 'none' : 'crosshair') 
          }}
          ref={viewerRef}
          onClick={handleViewerClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            setLensData(prev => ({ ...prev, show: false }));
            setHoverBubble(-1);
          }}
        >
          {pages.length > 0 ? (
            <>
              {/* Page drawn at native size, then scaled to fit the viewer */}
              <img
                key={pageUrl}
                ref={imageRef}
                src={pageUrl}
                alt="Comic Page"
                onLoad={(e) => setPageSize({ src: pageUrl, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  maxWidth: 'none',
                  width: layout ? pageSize.width : undefined,
                  height: layout ? pageSize.height : undefined,
                  transformOrigin: '0 0',
                  transform: layout ? `translate(${layout.tx}px, ${layout.ty}px) scale(${layout.scale})` : undefined,
                  visibility: layout ? 'visible' : 'hidden',
                  pointerEvents: 'none'
                }}
              />

              {/* Tint the bubble under the mouse (in its own shape) to show it can be clicked */}
              {bubbleMode && layout && hoverBubble >= 0 && hoverBubble !== activeBubble && pageBubbles?.[hoverBubble] && (
                <div
                  style={{
                    position: 'absolute',
                    ...bubbleRect(pageSize, layout, pageBubbles[hoverBubble]),
                    backgroundColor: 'rgb(var(--accent-400) / 0.35)',
                    ...shapeMask(pageBubbles[hoverBubble].maskUrl),
                    pointerEvents: 'none'
                  }}
                />
              )}

              {/* Enlarged copy of the active panel or bubble (cut to its shape), popping out of its spot
                  on the page. The outer layer casts a shadow that follows the shape; the inner one clips to it. */}
              {zoomBox && (
                <div
                  key={`${pageUrl}#${viewMode}${activeIndex}`}
                  style={{
                    position: 'absolute',
                    left: zoomBox.left,
                    top: zoomBox.top,
                    width: zoomBox.width,
                    height: zoomBox.height,
                    filter: 'drop-shadow(0 12px 22px rgba(0, 0, 0, 0.7))',
                    '--pop-from': zoomBox.popFrom,
                    animation: 'bubble-pop 320ms cubic-bezier(0.22, 1, 0.36, 1)',
                    pointerEvents: 'none',
                    zIndex: 10
                  }}
                >
                  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', ...(activeBubble !== null ? shapeMask(pageBubbles[activeBubble].maskUrl) : {}) }}>
                    <img
                      src={pageUrl}
                      alt=""
                      style={{
                        position: 'absolute',
                        left: zoomBox.imageLeft,
                        top: zoomBox.imageTop,
                        width: zoomBox.imageWidth,
                        height: zoomBox.imageHeight,
                        maxWidth: 'none'
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Brief position readout in the corner; remounts (and so replays its fade) on every change */}
              {viewMode !== 'lens' && (
                <div
                  key={`${zoomStatus(items, activeIndex, noun)}|${currentIndex}`}
                  className="absolute top-3 right-3 bg-gray-900/85 border border-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-full pointer-events-none tabular-nums"
                  style={{ zIndex: 11, animation: 'hud-fade 2.2s ease-in forwards' }}
                >
                  {zoomStatus(items, activeIndex, noun)} · Page {currentIndex + 1} / {pages.length}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center text-gray-500 text-center">
              <p className="text-lg mb-2">No comic loaded</p>
              <p className="text-sm">Click "Browse Comic" to load a .cbz or .cbr file.</p>
            </div>
          )}
        </div>

        {/* The Lens */}
        {lensData.show && pages.length > 0 && !isLoading && (
          <div
            style={{
              position: 'fixed',
              pointerEvents: 'none',
              zIndex: 50,
              border: '2px solid rgba(255,255,255,0.9)',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
              left: `${lensData.clientX - size / 2}px`,
              top: `${lensData.clientY - (shape === 'rectangle' ? (size * 0.75) / 2 : size / 2)}px`,
              width: `${size}px`,
              height: shape === 'rectangle' ? `${size * 0.75}px` : `${size}px`,
              borderRadius: shape === 'circle' ? '50%' : shape === 'square' ? '0px' : '12px',
              backgroundImage: `url("${pages[currentIndex]}")`,
              backgroundSize: `${lensData.bgWidth}px ${lensData.bgHeight}px`,
              backgroundPosition: `${lensData.bgX}px ${lensData.bgY}px`,
              backgroundRepeat: 'no-repeat',
            }}
          />
        )}
      </div>

    </div>
  );
}