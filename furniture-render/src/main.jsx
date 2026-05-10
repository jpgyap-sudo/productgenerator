import React, { useMemo, useState, useRef, useEffect, useCallback, useReducer, Component } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Box, CheckCircle2, ChevronDown, Cloud, Download, Eye, ImagePlus, Pencil,
  Plus, Share2, Sparkles, Upload, Clock, Zap, ShieldCheck, Wand2, X, RefreshCw,
  AlertCircle, FileImage, Settings, Sliders, Layers, Maximize2, Minimize2,
  ChevronRight, ChevronLeft, Info, Check, Loader2, ImageOff, Trash2, ZoomIn
} from 'lucide-react';
import BatchPanel from './BatchPanel.jsx';
import './styles.css';

// ── API Configuration ────────────────────────────────────────────
const API_BASE = window.location.origin;

// ── Mock / Real Data ─────────────────────────────────────────────
const VIEW_TYPES = [
  { id: 1, label: 'Front View', key: 'front' },
  { id: 2, label: 'Side View', key: 'side' },
  { id: 3, label: 'Isometric View', key: 'isometric' },
  { id: 4, label: 'Interior View', key: 'interior' },
];

const RESOLUTIONS = [
  { label: '0.5K', price: 0.06, value: '0.5K' },
  { label: '1K', price: 0.08, value: '1K' },
  { label: '2K', price: 0.12, value: '2K' },
  { label: '4K', price: 0.16, value: '4K' },
];

const PIPELINES = [
  { id: 'gpt-mini', label: 'ChatGPT Mini', desc: 'Main render + Gemini QA fix', icon: '🤖' },
  { id: 'gemini', label: 'Gemini Pro', desc: 'Full Gemini pipeline', icon: '✨' },
  { id: 'stability', label: 'Stability AI', desc: 'SDXL Turbo pipeline', icon: '🎨' },
  { id: 'hybrid', label: 'Hybrid (GPT → Gemini)', desc: 'GPT renders, Gemini repairs', icon: '🔄' },
];

const EST_TIME = {
  'gpt-mini':  { '0.5K': '~1m', '1K': '~1m 30s', '2K': '~2m', '4K': '~3m' },
  'gemini':    { '0.5K': '~1m 30s', '1K': '~2m', '2K': '~3m', '4K': '~4m' },
  'stability': { '0.5K': '~45s', '1K': '~1m', '2K': '~2m', '4K': '~3m' },
  'hybrid':    { '0.5K': '~2m', '1K': '~3m', '2K': '~4m', '4K': '~6m' },
};

// ── Helper: format time ──────────────────────────────────────────
function formatTime(d) {
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleTimeString();
}

// ── Toast System ─────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const addToast = useCallback((msg, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);
  return { toasts, addToast };
}

const toastIcons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

function ToastContainer({ toasts }) {
  return (
    <div className="fr-toast-container">
      {toasts.map(t => {
        const Icon = toastIcons[t.type] || Info;
        return (
          <div key={t.id} className={`fr-toast fr-toast-${t.type}`}>
            <Icon size={16} />
            <span>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Upload Card ──────────────────────────────────────────────────
function UploadCard({ file, filePreview, onRemove, onUpload }) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && ['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) {
      onUpload(f);
    }
  };

  return (
    <div>
      {file ? (
        <div className="fr-upload-card">
          <div className="fr-thumb">
            {filePreview ? (
              <img src={filePreview} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div className="fr-sofa" />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong title={file.name}>{file.name}</strong>
            <p>{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            <button className="fr-link-btn" onClick={onRemove}>
              <Trash2 size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`fr-drop-zone ${dragOver ? 'fr-drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.6 }}>
            <Upload size={28} />
          </div>
          <span style={{ fontWeight: 600 }}>Drop image here or click to browse</span>
          <br />
          <small>PNG · JPG · WEBP · Max 10MB</small>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files[0]) onUpload(e.target.files[0]);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────
function Sidebar({ state, dispatch, addToast }) {
  const handleFileUpload = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      dispatch({ type: 'SET_FILE', payload: { file, preview: e.target.result } });
      addToast('Image uploaded successfully', 'success');
    };
    reader.readAsDataURL(file);
  };

  const handleAddToQueue = async () => {
    if (!state.file) {
      addToast('Please upload a product image first', 'error');
      return;
    }
    dispatch({ type: 'SET_STATUS', payload: 'submitting' });
    try {
      const formData = new FormData();
      const resp = await fetch(state.filePreview);
      const blob = await resp.blob();
      formData.append('productImage', blob, state.file.name);
      formData.append('description', state.description);
      formData.append('brand', state.brand);
      formData.append('resolution', state.resolution);
      formData.append('provider', state.pipeline);

      const result = await fetch(`${API_BASE}/api/render/product`, {
        method: 'POST',
        body: formData,
      });
      const data = await result.json();
      if (data.error) throw new Error(data.error);

      // The /api/render/product endpoint returns outputs directly (synchronous)
      if (data.outputs && data.outputs.length > 0) {
        dispatch({ type: 'SET_RENDER_RESULTS', payload: data.outputs });
        addToast('Render complete!', 'success');
      } else {
        // Fallback: poll for results
        addToast('Added to render queue!', 'success');
        dispatch({ type: 'SET_STATUS', payload: 'queued' });
        dispatch({ type: 'SET_QUEUE_ID', payload: data.id || data.queueItemId });
      }
    } catch (err) {
      addToast(`Failed: ${err.message}`, 'error');
      dispatch({ type: 'SET_STATUS', payload: 'idle' });
    }
  };

  return (
    <aside className="fr-sidebar">
      <div className="fr-brand-block">
        <div className="fr-logo"><Box size={21} /></div>
        <div>
          <h1>Render Studio <span>BETA</span></h1>
          <p>AI Furniture Rendering</p>
        </div>
      </div>

      <section>
        <h3><span className="fr-step-number">1</span> Upload Product</h3>
        <UploadCard
          file={state.file}
          filePreview={state.filePreview}
          onRemove={() => dispatch({ type: 'CLEAR_FILE' })}
          onUpload={handleFileUpload}
        />
      </section>

      <section>
        <h3><span className="fr-step-number">2</span> Furniture Brand <em>(optional)</em></h3>
        <input
          value={state.brand}
          onChange={(e) => dispatch({ type: 'SET_BRAND', payload: e.target.value })}
          placeholder="e.g. Minotti, Poliform, Roche Bobois"
        />
        <p className="fr-hint">Helps AI match brand-specific style</p>
      </section>

      <section>
        <h3><span className="fr-step-number">3</span> Description <em>(optional)</em></h3>
        <textarea
          value={state.description}
          onChange={(e) => dispatch({ type: 'SET_DESC', payload: e.target.value })}
          placeholder="Describe materials, colors, style, or scene context..."
          rows={3}
        />
      </section>

      <section>
        <h3><span className="fr-step-number">4</span> Resolution</h3>
        <div className="fr-resolution-grid">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.value}
              className={state.resolution === r.value ? 'fr-selected' : ''}
              onClick={() => dispatch({ type: 'SET_RESOLUTION', payload: r.value })}
            >
              <span>{r.label}</span>
              <small>${r.price.toFixed(2)} / img</small>
            </button>
          ))}
        </div>
        <p className="fr-hint">0.5K is fastest and cheapest, good for drafts.</p>
      </section>

      <section>
        <h3><span className="fr-step-number">5</span> Render Pipeline</h3>
        <div className="fr-pipeline-grid">
          {PIPELINES.map((p) => (
            <button
              key={p.id}
              className={`fr-pipeline-btn ${state.pipeline === p.id ? 'fr-selected' : ''}`}
              onClick={() => dispatch({ type: 'SET_PIPELINE', payload: p.id })}
            >
              <span className="fr-pipeline-icon">{p.icon}</span>
              <div>
                <strong>{p.label}</strong>
                <small>{p.desc}</small>
              </div>
              {state.pipeline === p.id && <CheckCircle2 size={16} className="fr-check-icon" />}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3><span className="fr-step-number">6</span> Auto-Queue</h3>
        <div className="fr-toggle-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {state.autoQueue ? 'Auto-submit enabled' : 'Manual mode'}
            <span style={{ fontSize: 11, color: '#8e96a3' }}>
              {state.autoQueue ? '(renders start immediately)' : '(click to submit)'}
            </span>
          </span>
          <span
            className={`fr-toggle ${state.autoQueue ? 'fr-on' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_AUTO_QUEUE' })}
          />
        </div>
      </section>

      <div className="fr-sidebar-footer">
        <button
          className="fr-primary"
          onClick={handleAddToQueue}
          disabled={state.status === 'submitting' || !state.file}
        >
          {state.status === 'submitting' ? (
            <><Loader2 size={16} className="fr-spin" /> Submitting...</>
          ) : (
            <><Zap size={16} /> Add to Queue</>
          )}
        </button>
        <p>
          Est. cost: <strong style={{ color: '#d3a64f' }}>${(RESOLUTIONS.find(r => r.value === state.resolution)?.price || 0.06) * 4}</strong>
          {' · '}Est. time: <strong>{EST_TIME[state.pipeline]?.[state.resolution] || '~1m 30s'}</strong>
        </p>
      </div>
    </aside>
  );
}

// ── Top Navigation ───────────────────────────────────────────────
function TopNav({ activeTab, setActiveTab, queueCount, completedCount }) {
  return (
    <header className="fr-topbar">
      <div className="fr-topbar-left">
        <span className="fr-topbar-title">
          <Sparkles size={16} style={{ color: '#d3a64f' }} />
          Furniture Render Studio
        </span>
      </div>
      <nav>
        <a className={activeTab === 'studio' ? 'fr-active' : ''} onClick={() => setActiveTab('studio')}>
          <Box size={16} /> Studio
        </a>
        <a className={activeTab === 'batch' ? 'fr-active' : ''} onClick={() => setActiveTab('batch')}>
          <Layers size={16} /> Batch
        </a>
        <a className={activeTab === 'queue' ? 'fr-active' : ''} onClick={() => setActiveTab('queue')}>
          <Clock size={16} /> Queue <span>{queueCount}</span>
        </a>
        <a className={activeTab === 'completed' ? 'fr-active' : ''} onClick={() => setActiveTab('completed')}>
          <CheckCircle2 size={16} /> Completed <span>{completedCount}</span>
        </a>
        <a className={activeTab === 'templates' ? 'fr-active' : ''} onClick={() => setActiveTab('templates')}>
          <ImagePlus size={16} /> Templates
        </a>
        <div className="fr-nav-divider" />
        <a className="fr-sync"><Cloud size={16} /> Drive Sync</a>
        <button className="fr-avatar">AK</button>
      </nav>
    </header>
  );
}

// ── Generated View Card ──────────────────────────────────────────
function ViewCard({ view, index }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imgError, setImgError] = useState(false);

  const gradients = [
    'linear-gradient(135deg,#e9dfcf,#9d9284)',
    'linear-gradient(135deg,#d8c8b1,#7e7366)',
    'linear-gradient(135deg,#b8b0a3,#56514a)',
    'linear-gradient(135deg,#eee4d5,#8f887e)',
  ];

  const statusConfig = view.status === 'Complete' ? { color: '#65d579', label: 'Complete', icon: CheckCircle2 }
    : view.status === 'failed' ? { color: '#ff5555', label: 'Failed', icon: AlertCircle }
    : view.status.includes('Gemini') ? { color: '#b46cff', label: view.status, icon: Wand2 }
    : view.status.includes('Generating') ? { color: '#d3a64f', label: view.status, icon: Loader2 }
    : { color: '#8f97a3', label: view.status, icon: Clock };

  const StatusIcon = statusConfig.icon;
  const hasImage = !!view.imageUrl && !imgError;

  return (
    <div className="fr-view">
      <div
        className="fr-view-img"
        style={{
          background: hasImage ? '#000' : gradients[index % gradients.length],
        }}
      >
        {hasImage ? (
          <img
            src={view.imageUrl}
            alt={view.title}
            className="fr-render-img"
            onError={() => setImgError(true)}
            onClick={() => setLightboxOpen(true)}
            style={{ cursor: 'pointer' }}
          />
        ) : (
          <div className="fr-mini-sofa" />
        )}
        {!hasImage && (view.status.includes('Generating') || view.status === 'rendering') && (
          <div className="fr-view-spinner"><RefreshCw size={20} className="fr-spin" /></div>
        )}
        {!hasImage && view.status === 'failed' && (
          <div className="fr-view-error"><AlertCircle size={24} /></div>
        )}
        {hasImage && (
          <div className="fr-view-actions-overlay">
            <button onClick={() => setLightboxOpen(true)} title="Zoom">
              <ZoomIn size={14} />
            </button>
            <a href={view.imageUrl} download={`${view.title}.png`} title="Download">
              <Download size={14} />
            </a>
          </div>
        )}
      </div>
      <div className="fr-view-meta">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{view.title}</strong>
          <span className="fr-view-status-badge" style={{ backgroundColor: statusConfig.color + '22', color: statusConfig.color, border: `1px solid ${statusConfig.color}44` }}>
            <StatusIcon size={10} />
            {statusConfig.label}
          </span>
        </div>
        <small>{view.tag}</small>
      </div>

      {/* Lightbox — rendered via portal so .fr-view's CSS transform doesn't clip it */}
      {lightboxOpen && hasImage && createPortal(
        <div className="fr-lightbox" onClick={() => setLightboxOpen(false)}>
          <div className="fr-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="fr-lightbox-close" onClick={() => setLightboxOpen(false)}>
              <X size={20} />
            </button>
            <img src={view.imageUrl} alt={view.title} className="fr-lightbox-img" />
            <div className="fr-lightbox-info">
              <strong>{view.title}</strong>
              <a href={view.imageUrl} download={`${view.title}.png`} className="fr-lightbox-download">
                <Download size={14} /> Download
              </a>
              <a href={view.imageUrl} target="_blank" rel="noopener noreferrer" className="fr-lightbox-download">
                <Eye size={14} /> Open in new tab
              </a>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Pipeline Progress ────────────────────────────────────────────
function PipelineProgress({ currentStep }) {
  const steps = [
    { label: 'Uploaded', time: '12:01 PM', icon: CheckCircle2 },
    { label: 'GPT Mini', sub: 'Rendering', icon: Sparkles },
    { label: 'QA Check', sub: 'Passed', icon: CheckCircle2 },
    { label: 'Gemini Fix', sub: 'Repairing', icon: Wand2 },
    { label: 'Upscale', sub: 'Queued', icon: Clock },
    { label: 'Delivery', sub: 'Pending', icon: Cloud },
  ];

  return (
    <div className="fr-steps">
      {steps.map((s, i) => {
        const Icon = s.icon;
        const isActive = i <= currentStep;
        const isCurrent = i === currentStep;
        return (
          <div key={s.label} className={`fr-step ${isActive ? 'fr-active' : ''} ${isCurrent ? 'fr-current' : ''}`}>
            <span><Icon size={18} /></span>
            <b>{s.label}</b>
            <small>{s.sub || s.time}</small>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Studio ──────────────────────────────────────────────────
function MainStudio({ state, dispatch }) {
  // Map render results to view cards, handling both API formats:
  //   /api/render/product returns: { view, status, imageUrl, ... }
  //   /api/queue/status returns:   { viewId, status, imageUrl, ... }
  const generatedViews = state.renderResults.length > 0
    ? state.renderResults.map((r, i) => {
        const viewIndex = r.viewId ? (r.viewId - 1) : i;
        const viewLabel = VIEW_TYPES[viewIndex]?.label || `View ${viewIndex + 1}`;
        const isComplete = r.status === 'done' || r.status === 'generated' || r.status === 'fixed' || r.status === 'fallback';
        const isFailed = r.status === 'failed' || r.status === 'error';
        return {
          title: viewLabel,
          status: isComplete ? 'Complete' : isFailed ? 'failed' : 'rendering',
          tag: state.resolution,
          imageUrl: r.imageUrl || null,
        };
      })
    : state.mockMode
    ? [
        { title: 'Front View', status: 'Complete', tag: state.resolution, imageUrl: null },
        { title: 'Side View', status: 'Generating 42%', tag: state.resolution, imageUrl: null },
        { title: 'Isometric View', status: 'Complete', tag: state.resolution, imageUrl: null },
        { title: 'Interior View', status: 'Gemini Fix', tag: state.resolution, imageUrl: null },
      ]
    : [
        { title: 'Front View', status: 'Queued', tag: state.resolution, imageUrl: null },
        { title: 'Side View', status: 'Queued', tag: state.resolution, imageUrl: null },
        { title: 'Isometric View', status: 'Queued', tag: state.resolution, imageUrl: null },
        { title: 'Interior View', status: 'Queued', tag: state.resolution, imageUrl: null },
      ];

  const doneCount = generatedViews.filter(v => v.status === 'Complete').length;
  const totalCount = generatedViews.length;

  // Real QA scores from API results (qaScore is 0–100)
  const scoredResults = state.renderResults.filter(r => r.qaScore != null);
  const avgQaScore = scoredResults.length > 0
    ? Math.round(scoredResults.reduce((sum, r) => sum + r.qaScore, 0) / scoredResults.length)
    : null;
  const hasRealScores = !state.mockMode && avgQaScore !== null;

  return (
    <main className="fr-studio">
      <div className="fr-title-row">
        <div>
          <h2>
            <Sparkles size={20} />
            {state.file ? state.file.name.replace(/\.[^/.]+$/, '') : 'No Product Selected'}
            <Pencil size={16} className="fr-edit-icon" />
          </h2>
          <div className="fr-chips">
            <span>{state.brand || 'Unknown Brand'}</span>
            <span>{state.resolution}</span>
            <span>{PIPELINES.find(p => p.id === state.pipeline)?.label || 'GPT Mini'}</span>
            {state.status === 'done' && <span className="fr-chip-success">Render Complete</span>}
            {state.status === 'rendering' && <span className="fr-chip-progress">Rendering...</span>}
          </div>
        </div>
        <div className="fr-actions">
          <button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'queue' })}>
            <Clock size={16} /> View Queue
          </button>
          <button className="fr-gold" onClick={() => { dispatch({ type: 'CLEAR_FILE' }); }}>
            <Plus size={16} /> New Render
          </button>
        </div>
      </div>

      <section className="fr-hero-card">
        <div className="fr-hero-main">
          <h3>
            <FileImage size={14} />
            Original Product Image
            {state.filePreview && <span>Uploaded</span>}
          </h3>
          <div className="fr-product-preview">
            {state.filePreview ? (
              <img src={state.filePreview} alt="Product" className="fr-product-img" />
            ) : (
              <div className="fr-sofa-large" />
            )}
          </div>
        </div>
        <div className="fr-ai-detected">
          <h3>
            <Sparkles size={14} /> AI Detected
            <span className="fr-demo-label" style={{ marginLeft: 'auto' }}>DEMO</span>
          </h3>
          {[
            ['Category', state.brand ? `${state.brand} Furniture` : 'Product'],
            ['Style', 'Modern'],
            ['Material', 'Not specified'],
            ['Dominant Color', '● Beige'],
            ['Suggested Scene', 'Modern Living Room'],
          ].map(([a, b]) => (
            <p key={a}><span>{a}</span><strong>{b}</strong></p>
          ))}
          <button><Pencil size={14} /> Edit Detection</button>
        </div>
      </section>

      <section className="fr-views-card">
        <h3>
          <span>
            Generated Views
            <span className="fr-view-count">{doneCount}/{totalCount}</span>
          </span>
          <button onClick={() => {
            document.querySelector('.fr-view-grid')?.scrollIntoView({ behavior: 'smooth' });
          }}>
            <Maximize2 size={12} /> View All
          </button>
        </h3>
        <div className="fr-view-grid">
          {generatedViews.map((view, i) => (
            <ViewCard key={view.title + i} view={view} index={i} />
          ))}
        </div>
      </section>

      <section className="fr-bottom-grid">
        <div className="fr-progress-card">
          <h3><Zap size={14} /> Pipeline Progress</h3>
          <PipelineProgress currentStep={
            state.mockMode ? 3
            : state.status === 'done' ? 5
            : state.status === 'rendering' || state.status === 'queued' ? 1
            : state.status === 'submitting' ? 0
            : -1
          } />
          <div className="fr-note">
            <Sparkles size={16} />
            {state.mockMode
              ? 'Gemini is repairing geometry and lighting on the interior view...'
              : state.status === 'done'
              ? 'All views generated successfully! Download your renders below.'
              : 'Upload a product and add to queue to start rendering.'}
          </div>
        </div>
        <div className="fr-score-card">
          <h3>
            <ShieldCheck size={14} /> Scene Consistency Score
            {!hasRealScores && <span className="fr-demo-label">DEMO</span>}
          </h3>
          {hasRealScores ? (
            <>
              {scoredResults.map(r => (
                <p key={r.view}>
                  <span style={{ textTransform: 'capitalize' }}>{r.view} View</span>
                  <meter min="0" max="100" value={r.qaScore} />
                  <strong>{r.qaScore}%</strong>
                </p>
              ))}
            </>
          ) : (
            [
              ['Identity Match', '94%'],
              ['Geometry', '98%'],
              ['Material Accuracy', '91%'],
              ['Brand Style Match', '89%'],
            ].map(([a, b]) => (
              <p key={a}>
                <span>{a}</span>
                <meter min="0" max="100" value={parseInt(b)} />
                <strong>{b}</strong>
              </p>
            ))
          )}
          {hasRealScores ? (
            <h2 style={{ color: avgQaScore >= 90 ? '#64d675' : avgQaScore >= 75 ? '#d3a64f' : '#ff5555' }}>
              {avgQaScore}% <small>{avgQaScore >= 90 ? 'Excellent' : avgQaScore >= 75 ? 'Good' : 'Needs Work'}</small>
            </h2>
          ) : (
            <h2>93% <small>Excellent</small></h2>
          )}
        </div>
        <div className="fr-estimate-card">
          <h3><Sliders size={14} /> Estimate</h3>
          <p><span>Resolution</span><b>{state.resolution}</b></p>
          <p><span>Views</span><b>{state.renderResults.length > 0 ? `${doneCount}/${totalCount} done` : '4 planned'}</b></p>
          <p><span>Pipeline</span><b>{PIPELINES.find(p => p.id === state.pipeline)?.label || 'GPT Mini'}</b></p>
          <hr />
          <p><span>Estimated Cost</span><strong style={{ color: '#d3a64f' }}>${((RESOLUTIONS.find(r => r.value === state.resolution)?.price || 0.06) * 4).toFixed(2)}</strong></p>
          <p><span>Estimated Time</span><strong>{EST_TIME[state.pipeline]?.[state.resolution] || '~1m 30s'}</strong></p>
        </div>
      </section>
    </main>
  );
}

// ── Right Panel ──────────────────────────────────────────────────
function RightPanel({ state, dispatch }) {
  const activity = [
    ['12:04 PM', 'Gemini Flash', 'Repairing interior view geometry & lighting', 'purple'],
    ['12:03 PM', 'QA Check', 'Passed — no major issues detected', 'green'],
    ['12:02 PM', 'GPT Mini', 'Rendering completed, 4 views generated', 'green'],
    ['12:01 PM', 'Upload', `${state.file?.name || 'product.png'} uploaded`, 'gold'],
  ];

  const activityIcons = { green: CheckCircle2, gold: Upload, purple: Wand2 };

  return (
    <aside className="fr-right-panel">
      <section>
        <h3>
          <Clock size={14} /> Queue
          <button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'queue' })}>
            View all
          </button>
        </h3>
        <div className="fr-queue-item">
          <div className="fr-thumb">
            {state.filePreview ? (
              <img src={state.filePreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div className="fr-sofa" />
            )}
          </div>
          <div>
            <b>{state.file?.name?.replace(/\.[^/.]+$/, '') || 'Product'}</b>
            <p>4 views · {state.resolution}</p>
            <span className="fr-status-rendering">Rendering 42%</span>
          </div>
        </div>
        <div className="fr-queue-item">
          <div className="fr-thumb fr-chair" />
          <div>
            <b>Next in Queue</b>
            <p>4 views · 1K</p>
            <span className="fr-gold-text">Queued</span>
          </div>
        </div>
      </section>
      <section>
        <h3>
          <Info size={14} /> Activity Log
        </h3>
        {activity.map(([t, n, d, c]) => {
          const ActIcon = activityIcons[c] || Info;
          return (
            <div className="fr-log" key={t + n}>
              <time>{t}</time>
              <div className={`fr-${c}`}>
                <ActIcon size={8} style={{ color: c === 'gold' ? '#17140d' : '#fff' }} />
              </div>
              <p><b>{n}</b><span>{d}</span></p>
            </div>
          );
        })}
      </section>
    </aside>
  );
}

// ── Queue Panel ──────────────────────────────────────────────────
function QueuePanel({ state, dispatch }) {
  return (
    <div className="fr-panel-page">
      <h2><Clock size={20} /> Render Queue</h2>
      <p className="fr-panel-sub">Active and pending render jobs</p>
      <div className="fr-empty-state">
        <FileImage size={48} />
        <p>No items in queue. Upload a product and add to queue.</p>
        <button className="fr-primary" style={{ width: 'auto', padding: '10px 24px', marginTop: 8 }}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'studio' })}>
          <Plus size={16} /> Go to Studio
        </button>
      </div>
    </div>
  );
}

// ── Completed Panel ──────────────────────────────────────────────
function CompletedPanel({ state, dispatch }) {
  return (
    <div className="fr-panel-page">
      <h2><CheckCircle2 size={20} /> Completed Renders</h2>
      <p className="fr-panel-sub">History of all completed render jobs</p>
      {state.renderResults.length > 0 ? (
        <div className="fr-completed-grid">
          {state.renderResults.map((r, i) => (
            <div key={i} className="fr-completed-item">
              {r.imageUrl ? (
                <img src={r.imageUrl} alt={`Render ${i + 1}`} className="fr-completed-thumb" />
              ) : (
                <div className="fr-completed-placeholder" />
              )}
              <div className="fr-completed-info">
                <strong>{VIEW_TYPES[r.viewId ? r.viewId - 1 : i]?.label || `View ${i + 1}`}</strong>
                <span className="fr-chip-success">Complete</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="fr-empty-state">
          <CheckCircle2 size={48} />
          <p>No completed renders yet.</p>
          <button className="fr-primary" style={{ width: 'auto', padding: '10px 24px', marginTop: 8 }}
            onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'studio' })}>
            <Plus size={16} /> Start a Render
          </button>
        </div>
      )}
    </div>
  );
}

// ── Templates Panel ──────────────────────────────────────────────
function TemplatesPanel({ dispatch }) {
  return (
    <div className="fr-panel-page">
      <h2><ImagePlus size={20} /> Templates</h2>
      <p className="fr-panel-sub">Saved render configurations and presets</p>
      <div className="fr-empty-state">
        <Layers size={48} />
        <p>No templates saved yet.</p>
        <button className="fr-primary" style={{ width: 'auto', padding: '10px 24px', marginTop: 8 }}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'studio' })}>
          <Plus size={16} /> Create New Render
        </button>
      </div>
    </div>
  );
}

// ── App State ────────────────────────────────────────────────────
const initialState = {
  file: null,        // File object
  filePreview: null, // data URL string
  brand: '',
  description: '',
  resolution: '0.5K',
  pipeline: 'gpt-mini',
  autoQueue: true,
  status: 'idle', // idle | submitting | queued | rendering | done | error
  queueId: null,
  renderResults: [], // Array of { view, status, imageUrl, qaScore, ... }
  mockMode: true, // Show demo data
  activeTab: 'studio',
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FILE':
      return { ...state, file: action.payload.file, filePreview: action.payload.preview, status: 'idle', renderResults: [] };
    case 'CLEAR_FILE':
      return { ...state, file: null, filePreview: null, status: 'idle', renderResults: [] };
    case 'SET_BRAND':
      return { ...state, brand: action.payload };
    case 'SET_DESC':
      return { ...state, description: action.payload };
    case 'SET_RESOLUTION':
      return { ...state, resolution: action.payload };
    case 'SET_PIPELINE':
      return { ...state, pipeline: action.payload };
    case 'TOGGLE_AUTO_QUEUE':
      return { ...state, autoQueue: !state.autoQueue };
    case 'SET_STATUS':
      return { ...state, status: action.payload };
    case 'SET_QUEUE_ID':
      return { ...state, queueId: action.payload };
    case 'SET_RENDER_RESULTS':
      return { ...state, renderResults: action.payload, status: 'done' };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
    case 'TOGGLE_MOCK':
      return { ...state, mockMode: !state.mockMode };
    default:
      return state;
  }
}

// ── Poll for render results ──────────────────────────────────────
function useRenderPoller(state, dispatch, addToast) {
  useEffect(() => {
    if (state.status !== 'queued' || !state.queueId) return;

    const poll = async () => {
      try {
        // Use the existing /api/queue/status endpoint with itemId
        const res = await fetch(`${API_BASE}/api/queue/status?itemId=${state.queueId}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Check if render results are available for our item
        const results = data.renderResults?.[state.queueId];
        if (results && results.length > 0) {
          const allDone = results.every(r => r.status === 'done');
          const anyFailed = results.some(r => r.status === 'error');

          if (allDone) {
            dispatch({ type: 'SET_RENDER_RESULTS', payload: results });
            addToast('Render complete!', 'success');
          } else if (anyFailed && results.every(r => r.status === 'done' || r.status === 'error')) {
            // Some failed, some done — show what we have
            dispatch({ type: 'SET_RENDER_RESULTS', payload: results });
            addToast('Render completed with some errors', 'info');
          }
          // else still processing, keep polling
        }
      } catch (err) {
        // Silently retry on next interval
      }
    };

    // Poll every 5 seconds
    const interval = setInterval(poll, 5000);
    // Also poll immediately
    poll();

    return () => clearInterval(interval);
  }, [state.status, state.queueId]);
}

// ── App ──────────────────────────────────────────────────────────
function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { toasts, addToast } = useToast();
  useRenderPoller(state, dispatch, addToast);

  const renderContent = () => {
    switch (state.activeTab) {
      case 'batch':
        return <BatchPanel addToast={addToast} />;
      case 'queue':
        return <QueuePanel state={state} dispatch={dispatch} />;
      case 'completed':
        return <CompletedPanel state={state} dispatch={dispatch} />;
      case 'templates':
        return <TemplatesPanel dispatch={dispatch} />;
      default:
        return (
          <div className="fr-workspace">
            <MainStudio state={state} dispatch={dispatch} />
            <RightPanel state={state} dispatch={dispatch} />
          </div>
        );
    }
  };

  const doneCount = state.renderResults.filter(r =>
    r.status === 'done' || r.status === 'generated' || r.status === 'fixed' || r.status === 'fallback'
  ).length;

  return (
    <div className="fr-app">
      <Sidebar state={state} dispatch={dispatch} addToast={addToast} />
      <div className="fr-content">
        <TopNav
          activeTab={state.activeTab}
          setActiveTab={(tab) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tab })}
          queueCount={state.queueId ? 1 : 0}
          completedCount={doneCount}
        />
        {renderContent()}
      </div>
      <ToastContainer toasts={toasts} />
      {/* Mock mode indicator */}
      {state.mockMode && (
        <div
          className="fr-mock-badge"
          onClick={() => dispatch({ type: 'TOGGLE_MOCK' })}
          title="Click to disable mock mode"
        >
          MOCK
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#f4f0e8', fontFamily: 'Inter, sans-serif', background: '#0b0e13', minHeight: '100vh' }}>
          <h2 style={{ color: '#d3a64f' }}>Render Studio failed to load</h2>
          <pre style={{ color: '#ff5555', fontSize: 13, whiteSpace: 'pre-wrap' }}>{String(this.state.error)}</pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '10px 20px', background: '#d3a64f', border: 0, borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
