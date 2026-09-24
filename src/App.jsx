import React, { useState, useRef, useEffect } from 'react';
const { ipcRenderer } = window.require ? window.require('electron') : {};

export default function App() {
  const [pages, setPages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentFile, setCurrentFile] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);

  // Default Settings: Rectangle, 400px, 2x Zoom
  const [shape, setShape] = useState('rectangle');
  const [size, setSize] = useState(400);
  const [zoomLevel, setZoomLevel] = useState(2);

  // UI State
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [lensData, setLensData] = useState({ show: false, clientX: 0, clientY: 0, bgX: 0, bgY: 0, bgWidth: 0, bgHeight: 0 });
  const imageRef = useRef(null);

  // Load saved bookmarks on startup
  useEffect(() => {
    ipcRenderer?.invoke('bookmarks-get').then(setBookmarks);
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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (pages.length === 0) return;
      if (e.key === 'ArrowLeft') {
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'ArrowRight') {
        setCurrentIndex((prev) => Math.min(prev + 1, pages.length - 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pages.length]);

  const handleMouseMove = (e) => {
    if (isLoading) return;
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

    if (clickX < rect.width / 2) {
      setCurrentIndex((prev) => Math.max(prev - 1, 0));
    } else {
      setCurrentIndex((prev) => Math.min(prev + 1, pages.length - 1));
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', backgroundColor: '#000', color: '#fff', userSelect: 'none', overflow: 'hidden' }}>

      {/* Collapsible Sidebar Wrapper */}
      <div style={{ display: 'flex', zIndex: 20, height: '100%', position: 'relative' }}>
        
        {/* Sidebar Content Panel */}
        <div
          style={{
            width: isSidebarOpen ? '320px' : '0px',
            opacity: isSidebarOpen ? 1 : 0,
            transition: 'width 0.25s ease-in-out, opacity 0.2s ease-in-out',
            overflow: 'hidden',
            flexShrink: 0,
            height: '100%'
          }}
          className="bg-gray-900 border-r border-gray-800"
        >
          <div style={{ width: '320px' }} className="flex flex-col h-full">

            {/* Header: title, current comic, open button */}
            <div className="p-5 pb-4 border-b border-gray-800 shrink-0">
              <h1 className="text-lg font-bold text-indigo-400 tracking-tight">Comic Glass Reader</h1>
              {currentFile && pages.length > 0 ? (
                <div className="mt-2 mb-4">
                  <p className="text-sm text-gray-200 truncate" title={currentFile}>
                    {bookmarks.find(b => b.filePath === currentFile)?.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Page {currentIndex + 1} of {pages.length} · click sides or <kbd className="bg-gray-800 px-1 rounded text-gray-300">←</kbd> <kbd className="bg-gray-800 px-1 rounded text-gray-300">→</kbd>
                  </p>
                </div>
              ) : (
                <p className="text-xs text-gray-500 mt-2 mb-4">Open a comic to start reading.</p>
              )}
              <button
                onClick={handleOpenComic}
                disabled={isLoading}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 py-2 px-4 rounded-md font-medium transition shadow cursor-pointer text-sm"
              >
                📁 Browse Comic (.cbz, .cbr)
              </button>
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
                <ul className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1">
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
                            isCurrent ? 'bg-indigo-950/60 border-indigo-800' : 'border-transparent hover:bg-gray-800'
                          } ${b.missing ? 'opacity-50' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <p className={`flex-1 min-w-0 text-sm truncate ${isCurrent ? 'text-indigo-200' : 'text-gray-200'}`}>{b.name}</p>
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
                              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${progress}%` }} />
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

            {/* Lens settings: pinned to the bottom */}
            <div className="p-5 pt-4 border-t border-gray-800 shrink-0 space-y-3">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Lens Settings</h2>
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
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>
              <div>
                <label className="text-xs text-gray-300 flex justify-between mb-1"><span>Zoom Level</span><span className="text-gray-500">{zoomLevel}x</span></label>
                <input type="range" min="1.5" max="4" step="0.5" value={zoomLevel} onChange={(e) => setZoomLevel(Number(e.target.value))} className="w-full accent-indigo-500 cursor-pointer" />
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
            left: isSidebarOpen ? '320px' : '0px',
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
            <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-indigo-300 font-medium text-sm">Extracting and loading comic pages...</p>
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
            cursor: lensData.show ? 'none' : 'crosshair' 
          }}
          onClick={handleViewerClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setLensData(prev => ({ ...prev, show: false }))}
        >
          {pages.length > 0 ? (
            <img
              ref={imageRef}
              src={pages[currentIndex]}
              alt="Comic Page"
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                display: 'block',
                pointerEvents: 'none'
              }}
            />
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