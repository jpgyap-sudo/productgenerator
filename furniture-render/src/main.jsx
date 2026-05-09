import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box, CheckCircle2, ChevronDown, Cloud, Download, Eye, ImagePlus, Pencil,
  Plus, Share2, Sparkles, Upload, Clock, Zap, ShieldCheck, Wand2, X, RefreshCw,
  AlertCircle, FileImage, Settings, Sliders, Layers, Maximize2, Minimize2
} from 'lucide-react';
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

function ToastContainer({ toasts }) {
  return (
    <div className="fr-toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`fr-toast fr-toast-${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

// ── Upload Card ──────────────────────────────────────────────────
function UploadCard({ file, onRemove, onUpload }) {
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
          <div className="fr-thumb fr-sofa" />
          <div>
            <strong>{file.name}</strong>
            <p>{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            <button className="fr-link-btn" onClick={onRemove}>Remove</button>
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
          <Upload size={20} /> or drag & drop image here
          <br /><small>PNG · JPG · WEBP · Max 10MB</small>
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
      // Convert base64 to blob
      const resp = await fetch(state.file.preview);
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
      addToast('Added to render queue!', 'success');
      dispatch({ type: 'SET_STATUS', payload: 'queued' });
      dispatch({ type: 'SET_QUEUE_ID', payload: data.id || data.queueItemId });
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
        <h3>1. Upload Product</h3>
        <UploadCard
          file={state.file}
          onRemove={() => dispatch({ type: 'CLEAR_FILE' })}
          onUpload={handleFileUpload}
        />
      </section>

      <section>
        <h3>2. Furniture Brand <em>(optional)</em></h3>
        <input
          value={state.brand}
          onChange={(e) => dispatch({ type: 'SET_BRAND', payload: e.target.value })}
          placeholder="e.g. Minotti, Poliform, Roche Bobois"
        />
        <p className="fr-hint">Helps AI match brand-specific style</p>
      </section>

      <section>
        <h3>3. Description <em>(optional)</em></h3>
        <textarea
          value={state.description}
          onChange={(e) => dispatch({ type: 'SET_DESC', payload: e.target.value })}
          placeholder="Describe materials, colors, style..."
          rows={3}
        />
      </section>

      <section>
        <h3>4. Resolution</h3>
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
        <h3>5. Render Pipeline</h3>
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
        <h3>6. Auto-Queue</h3>
        <div className="fr-toggle-row">
          <span>Enabled</span>
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
            <><RefreshCw size={16} className="fr-spin" /> Submitting...</>
          ) : (
            <><Plus size={16} /> Add to Queue</>
          )}
        </button>
        <p>Est. cost: ${(RESOLUTIONS.find(r => r.value === state.resolution)?.price || 0.06) * 4} · Est. time: ~1m 30s</p>
      </div>
    </aside>
  );
}

// ── Top Navigation ───────────────────────────────────────────────
function TopNav({ activeTab, setActiveTab, queueCount, completedCount }) {
  return (
    <header className="fr-topbar">
      <div />
      <nav>
        <a className={activeTab === 'queue' ? 'fr-active' : ''} onClick={() => setActiveTab('queue')}>
          <Clock size={16} /> Queue <span>{queueCount}</span>
        </a>
        <a className={activeTab === 'completed' ? 'fr-active' : ''} onClick={() => setActiveTab('completed')}>
          <CheckCircle2 size={16} /> Completed <span>{completedCount}</span>
        </a>
        <a className={activeTab === 'templates' ? 'fr-active' : ''} onClick={() => setActiveTab('templates')}>
          <ImagePlus size={16} /> Templates
        </a>
        <a className="fr-sync"><Cloud size={16} /> Drive Sync · Connected</a>
        <button className="fr-avatar">AK</button>
        <ChevronDown size={16} />
      </nav>
    </header>
  );
}

// ── Generated View Card ──────────────────────────────────────────
function ViewCard({ view, index }) {
  const gradients = [
    'linear-gradient(135deg,#e9dfcf,#9d9284)',
    'linear-gradient(135deg,#d8c8b1,#7e7366)',
    'linear-gradient(135deg,#b8b0a3,#56514a)',
    'linear-gradient(135deg,#eee4d5,#8f887e)',
  ];

  const statusColor = view.status === 'Complete' ? '#65d579'
    : view.status.includes('Gemini') ? '#b46cff'
    : view.status.includes('Generating') ? '#d3a64f'
    : '#8f97a3';

  return (
    <div className="fr-view">
      <div className="fr-view-img" style={{ background: gradients[index % gradients.length] }}>
        <div className="fr-mini-sofa" />
        {view.status.includes('Generating') && (
          <div className="fr-view-spinner"><RefreshCw size={20} className="fr-spin" /></div>
        )}
      </div>
      <div className="fr-view-meta">
        <strong>{view.title}</strong>
        <small>{view.tag}</small>
        <span style={{ color: statusColor }}>{view.status}</span>
        <div>
          <Download size={15} />
          <Eye size={15} />
        </div>
      </div>
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
  const generatedViews = [
    { title: 'Front View', status: state.mockMode ? 'Complete' : 'Queued', tag: state.resolution },
    { title: 'Side View', status: state.mockMode ? 'Generating 42%' : 'Queued', tag: state.resolution },
    { title: 'Isometric View', status: state.mockMode ? 'Complete' : 'Queued', tag: state.resolution },
    { title: 'Interior View', status: state.mockMode ? 'Gemini Fix' : 'Queued', tag: state.resolution },
  ];

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
          </div>
        </div>
        <div className="fr-actions">
          <button><Share2 size={16} /> Share</button>
          <button className="fr-gold"><Plus size={16} /> New Render</button>
        </div>
      </div>

      <section className="fr-hero-card">
        <div className="fr-hero-main">
          <h3>Original Product Image <span>Uploaded</span></h3>
          <div className="fr-product-preview">
            {state.file ? (
              <img src={state.file.preview} alt="Product" className="fr-product-img" />
            ) : (
              <div className="fr-sofa-large" />
            )}
          </div>
        </div>
        <div className="fr-ai-detected">
          <h3>AI Detected</h3>
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
          Generated Views (4/4)
          <button>View Full Size</button>
        </h3>
        <div className="fr-view-grid">
          {generatedViews.map((view, i) => (
            <ViewCard key={view.title} view={view} index={i} />
          ))}
        </div>
      </section>

      <section className="fr-bottom-grid">
        <div className="fr-progress-card">
          <h3>Pipeline Progress</h3>
          <PipelineProgress currentStep={state.mockMode ? 3 : 0} />
          <div className="fr-note">
            <Sparkles size={16} />
            {state.mockMode
              ? 'Gemini is repairing geometry and lighting on the interior view...'
              : 'Upload a product and add to queue to start rendering.'}
          </div>
        </div>
        <div className="fr-score-card">
          <h3>Scene Consistency Score <ShieldCheck size={16} /></h3>
          {[
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
          ))}
          <h2>93% <small>Excellent</small></h2>
        </div>
        <div className="fr-estimate-card">
          <h3>Estimate</h3>
          <p><span>Resolution</span><b>{state.resolution}</b></p>
          <p><span>Views</span><b>4</b></p>
          <p><span>Pipeline</span><b>{PIPELINES.find(p => p.id === state.pipeline)?.label || 'GPT Mini'}</b></p>
          <hr />
          <p><span>Estimated Cost</span><strong>${(RESOLUTIONS.find(r => r.value === state.resolution)?.price || 0.06) * 4}</strong></p>
          <p><span>Estimated Time</span><strong>~1m 30s</strong></p>
        </div>
      </section>
    </main>
  );
}

// ── Right Panel ──────────────────────────────────────────────────
function RightPanel({ state }) {
  const activity = [
    ['12:04 PM', 'Gemini Flash', 'Repairing interior view geometry & lighting', 'purple'],
    ['12:03 PM', 'QA Check', 'Passed — no major issues detected', 'green'],
    ['12:02 PM', 'GPT Mini', 'Rendering completed, 4 views generated', 'green'],
    ['12:01 PM', 'Upload', `${state.file?.name || 'product.png'} uploaded`, 'gold'],
  ];

  return (
    <aside className="fr-right-panel">
      <section>
        <h3>Queue (2) <button>View all</button></h3>
        <div className="fr-queue-item">
          <div className="fr-thumb fr-sofa" />
          <div>
            <b>{state.file?.name?.replace(/\.[^/.]+$/, '') || 'Product'}</b>
            <p>4 views · {state.resolution}</p>
            <span>Rendering 42%</span>
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
        <h3>Activity Log</h3>
        {activity.map(([t, n, d, c]) => (
          <div className="fr-log" key={t + n}>
            <time>{t}</time>
            <div className={`fr-${c}`} />
            <p><b>{n}</b><span>{d}</span></p>
          </div>
        ))}
      </section>
    </aside>
  );
}

// ── Queue Panel ──────────────────────────────────────────────────
function QueuePanel({ state }) {
  return (
    <div className="fr-panel-page">
      <h2><Clock size={20} /> Render Queue</h2>
      <p className="fr-panel-sub">Active and pending render jobs</p>
      <div className="fr-empty-state">
        <FileImage size={48} />
        <p>No items in queue. Upload a product and add to queue.</p>
      </div>
    </div>
  );
}

// ── Completed Panel ──────────────────────────────────────────────
function CompletedPanel({ state }) {
  return (
    <div className="fr-panel-page">
      <h2><CheckCircle2 size={20} /> Completed Renders</h2>
      <p className="fr-panel-sub">History of all completed render jobs</p>
      <div className="fr-empty-state">
        <CheckCircle2 size={48} />
        <p>No completed renders yet.</p>
      </div>
    </div>
  );
}

// ── Templates Panel ──────────────────────────────────────────────
function TemplatesPanel() {
  return (
    <div className="fr-panel-page">
      <h2><ImagePlus size={20} /> Templates</h2>
      <p className="fr-panel-sub">Saved render configurations and presets</p>
      <div className="fr-empty-state">
        <Layers size={48} />
        <p>No templates saved yet.</p>
      </div>
    </div>
  );
}

// ── App State ────────────────────────────────────────────────────
const initialState = {
  file: null,
  brand: '',
  description: '',
  resolution: '0.5K',
  pipeline: 'gpt-mini',
  autoQueue: true,
  status: 'idle', // idle | submitting | queued | rendering | done | error
  queueId: null,
  mockMode: true, // Show demo data
  activeTab: 'studio',
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FILE':
      return { ...state, file: action.payload, status: 'idle' };
    case 'CLEAR_FILE':
      return { ...state, file: null, status: 'idle' };
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
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
    case 'TOGGLE_MOCK':
      return { ...state, mockMode: !state.mockMode };
    default:
      return state;
  }
}

// ── App ──────────────────────────────────────────────────────────
function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { toasts, addToast } = useToast();

  const renderContent = () => {
    switch (state.activeTab) {
      case 'queue':
        return <QueuePanel state={state} />;
      case 'completed':
        return <CompletedPanel state={state} />;
      case 'templates':
        return <TemplatesPanel />;
      default:
        return (
          <div className="fr-workspace">
            <MainStudio state={state} dispatch={dispatch} />
            <RightPanel state={state} />
          </div>
        );
    }
  };

  return (
    <div className="fr-app">
      <Sidebar state={state} dispatch={dispatch} addToast={addToast} />
      <div className="fr-content">
        <TopNav
          activeTab={state.activeTab}
          setActiveTab={(tab) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tab })}
          queueCount={2}
          completedCount={18}
        />
        {renderContent()}
      </div>
      <ToastContainer toasts={toasts} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
