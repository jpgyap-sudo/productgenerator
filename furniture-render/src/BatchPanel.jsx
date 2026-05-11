// ═══════════════════════════════════════════════════════════════════
//  BatchPanel.jsx — PDF+ZIP batch matching + PDF-only AI per-row matching
//
//  Workflow (PDF+ZIP mode):
//    1. Upload PDF + ZIP → server extracts products & images
//    2. Server runs batch pipeline (fingerprinting → candidate filter → verify)
//    3. Results returned with confidence scores, no separate match call needed
//    4. Display top candidates per product
//    5. User confirms or changes selection
//    6. Submit confirmed matches to render queue
//
//  Workflow (PDF-only mode):
//    1. Upload only a PDF (or WPS) → server extracts products from text
//       AND extracts page images from the PDF via sharp
//    2. AI matches each product to its corresponding PDF page image
//       using GPT-4o Vision (per-row matching)
//    3. Results show product code, description, photo, brand per row
//    4. User confirms or changes selection
//    5. Submit confirmed matches to render queue
//
//  Key rules:
//    - Never depend on ZIP order
//    - Never depend on ZIP filenames
//    - Never auto-accept low confidence (< 90%)
// ═══════════════════════════════════════════════════════════════════

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload, FileImage, ImagePlus, CheckCircle2, AlertCircle, Info,
  Loader2, Zap, X, ChevronDown, ChevronUp, Sparkles, Eye,
  Download, RefreshCw, Check, Clock, FileText, Archive, Search,
  ThumbsUp, ThumbsDown, ArrowRight, Layers, BarChart3, File
} from 'lucide-react';

const API_BASE = window.location.origin;

// ── Status constants ──────────────────────────────────────────────
const STATUS = {
  IDLE: 'idle',
  PDF_UPLOADING: 'pdf_uploading',
  PDF_EXTRACTING: 'pdf_extracting',
  PDF_DONE: 'pdf_done',
  PDF_ERROR: 'pdf_error',
  ZIP_UPLOADING: 'zip_uploading',
  ZIP_EXTRACTING: 'zip_extracting',
  ZIP_DONE: 'zip_done',
  ZIP_ERROR: 'zip_error',
  MATCHING: 'matching',
  MATCH_DONE: 'match_done',
  MATCH_ERROR: 'match_error',
  SUBMITTING: 'submitting',
  SUBMIT_DONE: 'submit_done',
  SUBMIT_ERROR: 'submit_error',
  // PDF-only mode statuses
  PDF_ONLY_EXTRACTING: 'pdf_only_extracting',
  PDF_ONLY_MATCHING: 'pdf_only_matching',
  PDF_ONLY_DONE: 'pdf_only_done',
  PDF_ONLY_ERROR: 'pdf_only_error',
  // .et extraction status (with progress bar)
  ET_EXTRACTING: 'et_extracting',
};

// ── Batch pipeline stage labels ───────────────────────────────────
const STAGE_LABELS = {
  queued: 'Queued',
  extracting_pdf: 'Extracting PDF pages...',
  fingerprinting_zip: 'Fingerprinting ZIP images (one-time AI)...',
  filtering_candidates: 'Filtering candidates (attribute scoring)...',
  verifying_with_openai: 'Verifying matches with AI...',
  retrying_failed: 'Retrying failed verifications...',
  needs_review: 'Matches need review',
  completed: 'Complete!',
  failed: 'Failed'
};

// ── PDF-only mode labels ──────────────────────────────────────────
const PDF_ONLY_LABELS = {
  extracting: 'Extracting products and page images from PDF...',
  matching: 'AI is matching each product to its page image...',
  complete: 'AI per-row matching complete!',
  error: 'PDF-only matching failed'
};

// ── .et extraction stage labels ────────────────────────────────────
const ET_EXTRACT_LABELS = {
  'Initializing': 'Initializing...',
  'Checking LibreOffice': 'Checking LibreOffice...',
  'Preparing temp directory': 'Preparing temp directory...',
  'Converting .et to .xlsx': 'Converting .et to .xlsx via LibreOffice...',
  'Retrying conversion': 'Retrying LibreOffice conversion...',
  'Extracting embedded images': 'Extracting embedded images from spreadsheet...',
  'Extracting product data': 'Extracting product data from rows...',
  'Building image data URLs': 'Building image previews...',
  'Complete': 'Extraction complete!',
  'Failed': 'Extraction failed'
};

// ── Confidence badge color ────────────────────────────────────────
function confidenceColor(level) {
  switch (level) {
    case 'high': return '#5bd46c';
    case 'medium': return '#d3a64f';
    case 'low': return '#ff6b4a';
    case 'none': return '#8e96a3';
    case 'error': return '#ff4444';
    default: return '#8e96a3';
  }
}

function confidenceLabel(level) {
  switch (level) {
    case 'high': return 'High (≥90%)';
    case 'medium': return 'Medium (70-89%)';
    case 'low': return 'Low (<70%)';
    case 'none': return 'No Match';
    case 'error': return 'Error';
    default: return level;
  }
}

// ── Format file size ──────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

// ── Drop Zone ─────────────────────────────────────────────────────
function DropZone({ label, accept, icon: Icon, onFile, disabled, currentFile }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  return (
    <div
      className={`vm-drop-zone ${dragOver ? 'vm-drag' : ''} ${disabled ? 'vm-disabled' : ''}`}
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      {currentFile ? (
        <div className="vm-drop-file">
          <div className="vm-drop-icon"><Icon size={24} /></div>
          <div className="vm-drop-info">
            <strong>{currentFile.name}</strong>
            <span>{formatSize(currentFile.size)}</span>
          </div>
          <CheckCircle2 size={18} className="vm-check-icon" />
        </div>
      ) : (
        <>
          <div className="vm-drop-icon"><Icon size={28} /></div>
          <span className="vm-drop-label">{label}</span>
          <small>Click or drag & drop</small>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); }}
      />
    </div>
  );
}

// ── Product Row Card ──────────────────────────────────────────────
function ProductRowCard({ product, match, index, onConfirm, onSelectImage }) {
  const [expanded, setExpanded] = useState(false);

  const candidates = [];
  if (match?.bestMatch) candidates.push({ ...match.bestMatch, rank: 1 });
  if (match?.secondMatch) candidates.push({ ...match.secondMatch, rank: 2 });
  if (match?.thirdMatch) candidates.push({ ...match.thirdMatch, rank: 3 });

  const selectedImageIndex = match?.selectedImageIndex ?? 0;
  const selectedCandidate = candidates[selectedImageIndex] || null;

  return (
    <div className={`vm-product-card ${match?.confirmed ? 'vm-confirmed' : ''}`}>
      <div className="vm-product-header" onClick={() => setExpanded(!expanded)}>
        <div className="vm-product-info">
          <span className="vm-product-index">#{index + 1}</span>
          <div>
            <strong>{product.name || product.productCode || `Product ${index + 1}`}</strong>
            <div className="vm-product-meta">
              {product.productCode && <span>Code: {product.productCode}</span>}
              {product.category && <span>{product.category}</span>}
              {product.page && <span>Page {product.page}</span>}
            </div>
          </div>
        </div>
        <div className="vm-product-status">
          {match?.confirmed ? (
            <span className="vm-badge vm-badge-confirmed">
              <Check size={12} /> Confirmed
            </span>
          ) : match?.geminiFallback ? (
            <span className="vm-badge vm-badge-gemini">
              <Sparkles size={12} /> Gemini
            </span>
          ) : match?.overallConfidence === 'high' ? (
            <span className="vm-badge vm-badge-auto">
              <Sparkles size={12} /> Auto
            </span>
          ) : match?.overallConfidence ? (
            <span
              className="vm-badge"
              style={{ borderColor: confidenceColor(match.overallConfidence) + '44', color: confidenceColor(match.overallConfidence) }}
            >
              {confidenceLabel(match.overallConfidence)}
            </span>
          ) : null}
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>

      {expanded && (
        <div className="vm-product-body">
          {/* Product attributes */}
          <div className="vm-attributes">
            {[
              ['Code', product.productCode || product.generatedCode],
              ['Category', product.category],
              ['Material', product.material],
              ['Color', product.color],
              ['Dimensions', product.dimensions],
              ['Description', product.description],
            ].filter(([, v]) => v).map(([label, value]) => (
              <div key={label} className="vm-attr">
                <span className="vm-attr-label">{label}</span>
                <span className="vm-attr-value">{value}</span>
              </div>
            ))}
          </div>

          {/* Candidates grid */}
          {candidates.length > 0 ? (
            <div className="vm-candidates">
              <h4>Top {candidates.length} Image Candidates</h4>
              <div className="vm-candidates-grid">
                {candidates.map((cand, ci) => (
                  <div
                    key={cand.imageId}
                    className={`vm-candidate-card ${ci === selectedImageIndex ? 'vm-selected' : ''}`}
                    onClick={() => onSelectImage?.(index, ci)}
                  >
                    <div className="vm-candidate-img-wrap">
                      {cand.dataUrl ? (
                        <img src={cand.dataUrl} alt={`Candidate ${ci + 1}`} className="vm-candidate-img" />
                      ) : (
                        <div className="vm-candidate-placeholder">
                          <FileImage size={24} />
                        </div>
                      )}
                      <div className="vm-candidate-rank">#{ci + 1}</div>
                      {ci === selectedImageIndex && (
                        <div className="vm-candidate-selected">
                          <Check size={14} />
                        </div>
                      )}
                    </div>
                    <div className="vm-candidate-info">
                      <div className="vm-candidate-confidence">
                        <div
                          className="vm-confidence-bar"
                          style={{
                            width: (cand.confidence || 0) + '%',
                            background: (cand.confidence || 0) >= 90 ? '#5bd46c' : (cand.confidence || 0) >= 70 ? '#d3a64f' : '#ff6b4a'
                          }}
                        />
                      </div>
                      <span className="vm-candidate-pct">{cand.confidence || '?'}%</span>
                      <small className="vm-candidate-reason">{cand.reason || ''}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="vm-no-match">
              <AlertCircle size={16} />
              <span>{match?.overallReason || 'No matching candidates'}</span>
            </div>
          )}

          {/* Confirm button */}
          {candidates.length > 0 && !match?.confirmed && (
            <button
              className="vm-confirm-btn"
              onClick={() => onConfirm?.(index, selectedImageIndex)}
            >
              <Check size={14} /> Confirm Selection
            </button>
          )}
          {match?.confirmed && (
            <div className="vm-confirmed-badge-row">
              <CheckCircle2 size={14} />
              <span>Confirmed — image #{selectedImageIndex + 1} selected</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────
function StatsBar({ stats }) {
  if (!stats) return null;
  return (
    <div className="vm-stats">
      <div className="vm-stat">
        <FileText size={14} />
        <span>{stats.totalProducts} products</span>
      </div>
      <div className="vm-stat">
        <ImagePlus size={14} />
        <span>{stats.totalImages} images</span>
      </div>
      <div className="vm-stat">
        <Sparkles size={14} />
        <span>{stats.fingerprintsCreated} fingerprints</span>
      </div>
      <div className="vm-stat vm-stat-auto">
        <CheckCircle2 size={14} />
        <span>{stats.autoAccepted} auto-accepted</span>
      </div>
      {stats.geminiFallback > 0 && (
        <div className="vm-stat vm-stat-gemini">
          <Sparkles size={14} />
          <span>{stats.geminiFallback} gemini-fallback</span>
        </div>
      )}
      <div className="vm-stat vm-stat-review">
        <Eye size={14} />
        <span>{stats.needsReview} need review</span>
      </div>
    </div>
  );
}

// ── Batch Progress Bar ────────────────────────────────────────────
function BatchProgressBar({ batchId, status, setStatus, setProgressMsg, addToast }) {
  const POLL_INTERVAL = 3000; // 3 seconds

  useEffect(() => {
    if (!batchId) return;
    if (status === STATUS.MATCH_DONE || status === STATUS.MATCH_ERROR) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agent/batch-status/${batchId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        if (data.error) {
          console.warn('[BatchProgress] Poll error:', data.error);
          return;
        }

        const stage = data.stage || '';
        const progress = data.progress_percent || 0;
        const eta = data.estimated_seconds_remaining
          ? ` (~${Math.round(data.estimated_seconds_remaining / 60)}m ${data.estimated_seconds_remaining % 60}s)`
          : '';
        const stageLabel = STAGE_LABELS[stage] || stage;
        const completed = data.completed_products || 0;
        const total = data.total_products || 0;

        setProgressMsg(`${stageLabel} ${completed}/${total}${eta}`);

        // If completed or failed, stop polling
        if (data.status === 'completed' || data.status === 'failed') {
          setStatus(data.status === 'completed' ? STATUS.MATCH_DONE : STATUS.MATCH_ERROR);
          if (data.status === 'completed') {
            addToast('Batch pipeline completed!', 'success');
          } else {
            addToast(`Batch failed: ${data.last_error || 'Unknown error'}`, 'error');
          }
          return;
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[BatchProgress] Poll fetch error:', err.message);
        }
      }
    };

    // Initial delay then poll
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, status, setStatus, setProgressMsg, addToast]);

  return null; // Renders nothing — just drives polling
}

// ── ET Extraction Progress Bar ────────────────────────────────────
// Polls /api/agent/et-progress/:batchId during .et file extraction
// to show a real-time progress bar with stage labels.
function EtProgressBar({ batchId, status, setStatus, setProgressMsg, addToast, etProgress, setEtProgress }) {
  const POLL_INTERVAL = 1000; // 1 second

  useEffect(() => {
    if (!batchId) return;
    if (status !== STATUS.ET_EXTRACTING) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agent/et-progress/${batchId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        if (data.exists) {
          setEtProgress({ percent: data.percent, stage: data.stage, detail: data.detail });

          // Map stage to user-friendly label
          const stageLabel = ET_EXTRACT_LABELS[data.stage] || data.stage;
          const detailText = data.detail ? ` — ${data.detail}` : '';
          setProgressMsg(`${stageLabel}${detailText}`);

          // If complete or failed, stop polling
          if (data.stage === 'Complete' || data.stage === 'Failed') {
            // Don't change status here — the main fetch response will handle it
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[EtProgress] Poll fetch error:', err.message);
        }
      }
    };

    // Initial delay then poll
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, status, setStatus, setProgressMsg, addToast, setEtProgress]);

  return null; // Renders nothing — just drives polling
}

// ── Main BatchPanel Component ─────────────────────────────────────
export default function BatchPanel({ addToast }) {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [pdfFile, setPdfFile] = useState(null);
  const [zipFile, setZipFile] = useState(null);
  const [products, setProducts] = useState([]);
  const [images, setImages] = useState([]);
  const [matches, setMatches] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [batchId, setBatchId] = useState(null);
  const [isPdfOnlyMode, setIsPdfOnlyMode] = useState(false);
  const [pdfOnlyPaused, setPdfOnlyPaused] = useState(false);
  const [etProgress, setEtProgress] = useState({ percent: 0, stage: '', detail: '' });
  const pdfOnlyAbortRef = useRef(null);

  // ── Handle PDF upload ───────────────────────────────────────────
  const handlePdfUpload = useCallback(async (file) => {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    const isWps = file.name.toLowerCase().endsWith('.wps');
    const isEt = file.name.toLowerCase().endsWith('.et');
    if (!isPdf && !isWps && !isEt) {
      addToast('Please select a PDF, WPS, or .et file', 'error');
      return;
    }
    setPdfFile(file);
    // If ZIP is already selected, auto-process both (standard mode)
    if (zipFile) {
      setIsPdfOnlyMode(false);
      await handleProcessBoth(file, zipFile);
    } else {
      // No ZIP selected — offer PDF-only mode
      addToast('PDF selected. Upload a ZIP for standard matching, or click "Run AI Per-Row Matching" for PDF-only mode.', 'info');
    }
  }, [addToast, zipFile]);

  // ── Handle ZIP upload ───────────────────────────────────────────
  const handleZipUpload = useCallback(async (file) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      addToast('Please select a ZIP file', 'error');
      return;
    }
    setZipFile(file);
    setIsPdfOnlyMode(false);
    // If PDF is already selected, auto-process both
    if (pdfFile) {
      await handleProcessBoth(pdfFile, file);
    } else {
      addToast('ZIP selected. Now upload the PDF file to begin processing.', 'info');
    }
  }, [addToast, pdfFile]);

  // ── Process both PDF + ZIP via multipart upload ─────────────────
  //     Sends useBatchQueue=true so the server runs the full batch
  //     pipeline (fingerprinting → candidate filter → verify) and
  //     returns matches directly — no separate match-vision call needed.
  const handleProcessBoth = useCallback(async (pdf, zip) => {
    setError(null);
    setStatus(STATUS.PDF_UPLOADING);
    setProgressMsg('Uploading PDF and ZIP...');

    try {
      const formData = new FormData();
      formData.append('pdf', pdf);
      formData.append('zip', zip);
      formData.append('useBatchQueue', 'true');

      setProgressMsg('Extracting products and images...');
      setStatus(STATUS.PDF_EXTRACTING);

      const res = await fetch(`${API_BASE}/api/agent/process`, {
        method: 'POST',
        body: formData
        // No Content-Type header — browser sets multipart boundary automatically
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const extractedProducts = data.products || data.items || [];
      const extractedImages = data.allImages || [];

      if (extractedProducts.length === 0) {
        throw new Error(data.warning || 'No products found in PDF');
      }
      if (extractedImages.length === 0) {
        throw new Error('No images found in ZIP');
      }

      setProducts(extractedProducts);
      setImages(extractedImages);

      // ── Batch pipeline response ──────────────────────────────────
      // If the server ran the batch pipeline, matches are returned inline.
      if (data.batchMode && data.matches) {
        // Enrich matches with image data URLs for display
        const enrichedMatches = data.matches.map(m => {
          const bestImg = m.bestMatch && extractedImages[m.bestMatch.imageIndex];
          return {
            productIndex: m.productIndex,
            product: m.product,
            bestMatch: bestImg ? {
              imageIndex: m.bestMatch.imageIndex,
              imageName: m.bestMatch.imageName,
              confidence: m.bestMatch.confidence,
              reason: m.bestMatch.reason,
              status: m.bestMatch.status,
              dataUrl: bestImg.dataUrl
            } : null,
            secondMatch: null,
            thirdMatch: null,
            overallConfidence: m.bestMatch?.confidence >= 90 ? 'high'
              : m.bestMatch?.confidence >= 70 ? 'medium'
              : m.bestMatch?.confidence ? 'low' : 'none',
            overallReason: m.reason || m.bestMatch?.reason || '',
            selectedImageIndex: 0,
            confirmed: m.bestMatch?.status === 'auto_accepted',
            batchStatus: m.status
          };
        });

        setMatches(enrichedMatches);
        setBatchId(data.batchId || null);
        setStats(data.matchStats || {
          totalProducts: extractedProducts.length,
          totalImages: extractedImages.length,
          fingerprintsCreated: 0,
          autoAccepted: enrichedMatches.filter(m => m.confirmed).length,
          needsReview: enrichedMatches.filter(m => !m.confirmed).length
        });
        setStatus(STATUS.MATCH_DONE);

        const autoCount = enrichedMatches.filter(m => m.confirmed).length;
        addToast(
          `Batch complete: ${autoCount} auto-accepted, ${enrichedMatches.length - autoCount} need review`,
          autoCount > 0 ? 'success' : 'info'
        );
      } else if (data.batchMode && data.batchId && !data.matches) {
        // Batch pipeline is still running — set up polling
        setBatchId(data.batchId);
        setStatus(STATUS.MATCHING);
        setProgressMsg('Batch pipeline running...');
        addToast('Batch pipeline started. Processing...', 'info');
      } else {
        // Standard mode (no batch pipeline) — show products/images, user clicks "Run Matching"
        setStatus(STATUS.ZIP_DONE);
        addToast(`Extracted ${extractedProducts.length} products and ${extractedImages.length} images`, 'success');
      }
    } catch (err) {
      setError(err.message);
      setStatus(STATUS.PDF_ERROR);
      addToast(`Processing failed: ${err.message}`, 'error');
    }
  }, [addToast]);

  // ── PDF-only / .et-only: Upload and extract ─────────────────────
  const handlePdfOnlyProcess = useCallback(async () => {
    if (!pdfFile) {
      addToast('Please upload a PDF file first', 'error');
      return;
    }

    setError(null);
    setIsPdfOnlyMode(true);
    setZipFile(null); // Clear any ZIP reference
    setMatches([]);
    setProducts([]);
    setImages([]);

    const isEtFile = pdfFile.name.toLowerCase().endsWith('.et');

    if (isEtFile) {
      // .et files: Set ET_EXTRACTING status and a temporary batchId so the
      // EtProgressBar component starts polling immediately for progress updates.
      // The server stores progress in a global Map keyed by batchId.
      const tempBatchId = `et_${Date.now()}`;
      setBatchId(tempBatchId);
      setEtProgress({ percent: 0, stage: 'Initializing', detail: '' });
      setStatus(STATUS.ET_EXTRACTING);
      setProgressMsg('Initializing .et extraction...');
    } else {
      setStatus(STATUS.PDF_ONLY_EXTRACTING);
      setProgressMsg(PDF_ONLY_LABELS.extracting);
    }

    try {
      const formData = new FormData();
      formData.append('pdf', pdfFile);

      const res = await fetch(`${API_BASE}/api/agent/process`, {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // ── .et with embedded images ──────────────────────────────────
      // Server returns hasEmbeddedImages: true with pre-mapped products + images
      // No AI matching needed — images are already mapped to rows
      if (data.hasEmbeddedImages) {
        const extractedProducts = data.products || [];
        const extractedImages = data.allImages || [];

        if (extractedProducts.length === 0) {
          throw new Error(data.warning || 'No products could be extracted from the .et file');
        }
        if (extractedImages.length === 0) {
          throw new Error('No embedded images could be extracted from the .et file');
        }

        setProducts(extractedProducts);
        setImages(extractedImages);

        // Create direct matches from pre-mapped data (no AI needed)
        const directMatches = extractedProducts.map((product, idx) => {
          // Find the image that matches this product's pre-mapped image
          const matchedImage = product.hasPreMappedImage && product.imageName
            ? extractedImages.findIndex(img => img.name === product.imageName)
            : -1;

          const imageIndex = matchedImage >= 0 ? matchedImage : (idx < extractedImages.length ? idx : 0);
          const bestImg = extractedImages[imageIndex];

          return {
            productIndex: idx,
            product,
            bestMatch: bestImg ? {
              imageIndex,
              imageName: bestImg.name,
              confidence: 100,
              reason: 'Pre-mapped from .et spreadsheet cell',
              status: 'auto_accepted',
              dataUrl: bestImg.dataUrl
            } : null,
            secondMatch: null,
            thirdMatch: null,
            overallConfidence: 'high',
            overallReason: 'Image extracted from .et spreadsheet cell',
            selectedImageIndex: 0,
            confirmed: true,
            batchStatus: 'completed'
          };
        });

        setMatches(directMatches);
        setStats({
          totalProducts: extractedProducts.length,
          totalImages: extractedImages.length,
          autoAccepted: directMatches.filter(m => m.confirmed).length,
          needsReview: 0
        });
        setStatus(STATUS.PDF_ONLY_DONE);
        setEtProgress({ percent: 100, stage: 'Complete', detail: '' });

        addToast(
          `.et processed: ${extractedProducts.length} products with ${extractedImages.length} embedded images`,
          'success'
        );
        return;
      }

      // ── PDF/WPS standalone mode ───────────────────────────────────
      if (!data.isPdfOnly) {
        throw new Error('Server did not return PDF-only mode. The PDF may need a ZIP file.');
      }

      const extractedProducts = data.products || [];
      const extractedImages = data.allImages || [];

      if (extractedProducts.length === 0) {
        throw new Error(data.warning || 'No products could be extracted from the PDF');
      }
      if (extractedImages.length === 0) {
        throw new Error('No page images could be extracted from the PDF');
      }

      setProducts(extractedProducts);
      setImages(extractedImages);

      // Auto-launch AI per-row matching
      await handlePdfOnlyMatching(extractedProducts, extractedImages);

    } catch (err) {
      setError(err.message);
      // If we were in ET_EXTRACTING mode, set error status appropriately
      if (isEtFile) {
        setEtProgress({ percent: 0, stage: 'Failed', detail: err.message });
        setStatus(STATUS.PDF_ONLY_ERROR);
      } else {
        setStatus(STATUS.PDF_ONLY_ERROR);
      }
      addToast(`Processing failed: ${err.message}`, 'error');
    }
  }, [pdfFile, addToast]);

  // ── PDF-only: AI per-row matching ───────────────────────────────
  const handlePdfOnlyMatching = useCallback(async (prods, imgs) => {
    const productsToMatch = prods || products;
    const imagesToMatch = imgs || images;

    if (productsToMatch.length === 0 || imagesToMatch.length === 0) {
      addToast('Need both products and page images for matching', 'error');
      return;
    }

    // Create abort controller for this matching session
    const abortController = new AbortController();
    pdfOnlyAbortRef.current = abortController;
    setPdfOnlyPaused(false);
    setError(null);

    setStatus(STATUS.PDF_ONLY_MATCHING);
    setProgressMsg(PDF_ONLY_LABELS.matching);

    try {
      const res = await fetch(`${API_BASE}/api/agent/match-pdf-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: productsToMatch,
          images: imagesToMatch
        }),
        signal: abortController.signal
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Enrich matches with image data URLs for display
      const enrichedMatches = data.matches.map(m => {
        const enrich = (cand) => {
          if (!cand) return null;
          const img = imagesToMatch[cand.imageIndex];
          return {
            ...cand,
            dataUrl: img?.dataUrl || null
          };
        };
        return {
          ...m,
          bestMatch: enrich(m.bestMatch),
          secondMatch: enrich(m.secondMatch),
          thirdMatch: enrich(m.thirdMatch),
          selectedImageIndex: 0,
          confirmed: m.confirmed || m.overallConfidence === 'high'
        };
      });

      setMatches(enrichedMatches);
      setStats(data.stats || {
        totalProducts: productsToMatch.length,
        totalImages: imagesToMatch.length,
        autoAccepted: enrichedMatches.filter(m => m.confirmed).length,
        needsReview: enrichedMatches.filter(m => !m.confirmed).length
      });
      setStatus(STATUS.PDF_ONLY_DONE);
      setPdfOnlyPaused(false);
      pdfOnlyAbortRef.current = null;

      const autoCount = enrichedMatches.filter(m => m.confirmed).length;
      const reviewCount = enrichedMatches.length - autoCount;
      addToast(
        `AI per-row matching complete: ${autoCount} auto-accepted, ${reviewCount} need review`,
        autoCount > 0 ? 'success' : 'info'
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled — stay in current state, don't show error
        setStatus(STATUS.PDF_ONLY_ERROR);
        setPdfOnlyPaused(false);
        pdfOnlyAbortRef.current = null;
        addToast('PDF-only matching cancelled.', 'info');
        return;
      }
      setError(err.message);
      setStatus(STATUS.PDF_ONLY_ERROR);
      setPdfOnlyPaused(false);
      pdfOnlyAbortRef.current = null;
      addToast(`AI matching failed: ${err.message}`, 'error');
    }
  }, [products, images, addToast]);

  // ── PDF-only: Pause matching ────────────────────────────────────
  const handlePdfOnlyPause = useCallback(() => {
    if (pdfOnlyAbortRef.current) {
      pdfOnlyAbortRef.current.abort();
      setPdfOnlyPaused(true);
      setProgressMsg('PDF-only matching paused. Click "Resume" to re-run.');
      addToast('PDF-only matching paused. You can resume by clicking "Re-run AI Per-Row Matching".', 'info');
    }
  }, [addToast]);

  // ── PDF-only: Resume matching ───────────────────────────────────
  const handlePdfOnlyResume = useCallback(() => {
    // Re-run matching with current products and images
    setPdfOnlyPaused(false);
    handlePdfOnlyMatching(products, images);
  }, [products, images, handlePdfOnlyMatching]);

  // ── Run vision matching (PDF+ZIP mode) ──────────────────────────
  const handleRunMatching = useCallback(async () => {
    if (products.length === 0 || images.length === 0) {
      addToast('Need both PDF products and ZIP images', 'error');
      return;
    }

    setError(null);
    setStatus(STATUS.MATCHING);
    setProgressMsg('Creating visual fingerprints for each image...');
    setMatches([]);

    try {
      const res = await fetch(`${API_BASE}/api/agent/match-vision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products, images })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Enrich matches with image data URLs for display
      const enrichedMatches = data.matches.map(m => {
        const enrich = (cand) => {
          if (!cand) return null;
          const img = images[cand.imageIndex];
          return {
            ...cand,
            dataUrl: img?.dataUrl || null
          };
        };
        return {
          ...m,
          bestMatch: enrich(m.bestMatch),
          secondMatch: enrich(m.secondMatch),
          thirdMatch: enrich(m.thirdMatch),
          selectedImageIndex: 0,
          confirmed: m.autoAccept
        };
      });

      setMatches(enrichedMatches);
      setStats(data.stats);
      setStatus(STATUS.MATCH_DONE);

      const autoCount = enrichedMatches.filter(m => m.autoAccept).length;
      const geminiCount = enrichedMatches.filter(m => m.geminiFallback).length;
      const reviewCount = enrichedMatches.length - autoCount - geminiCount;
      let msg = `Matching complete: ${autoCount} auto-accepted`;
      if (geminiCount > 0) msg += `, ${geminiCount} gemini-fallback`;
      msg += `, ${reviewCount} need review`;
      addToast(msg, autoCount > 0 ? 'success' : 'info');
    } catch (err) {
      setError(err.message);
      setStatus(STATUS.MATCH_ERROR);
      addToast(`Matching failed: ${err.message}`, 'error');
    }
  }, [products, images, addToast]);

  // ── Confirm a product's selection ───────────────────────────────
  const handleConfirm = useCallback((productIndex, imageIndex) => {
    setMatches(prev => prev.map((m, i) =>
      i === productIndex
        ? { ...m, selectedImageIndex: imageIndex, confirmed: true }
        : m
    ));
    addToast(`Product #${productIndex + 1} confirmed`, 'success');
  }, [addToast]);

  // ── Select a different image for a product ──────────────────────
  const handleSelectImage = useCallback((productIndex, imageIndex) => {
    setMatches(prev => prev.map((m, i) =>
      i === productIndex
        ? { ...m, selectedImageIndex: imageIndex, confirmed: false }
        : m
    ));
  }, []);

  // ── Submit confirmed matches to render queue ────────────────────
  const handleSubmitToQueue = useCallback(async () => {
    const confirmed = matches.filter(m => m.confirmed);
    if (confirmed.length === 0) {
      addToast('No confirmed matches to submit', 'error');
      return;
    }

    setStatus(STATUS.SUBMITTING);
    setProgressMsg(`Submitting ${confirmed.length} confirmed products to render queue...`);

    try {
      const res = await fetch(`${API_BASE}/api/render-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: confirmed.map(m => ({
            product: m.product,
            imageIndex: m.selectedImageIndex,
            imageId: m.bestMatch?.imageId || m.secondMatch?.imageId || m.thirdMatch?.imageId,
            imageDataUrl: images[m.selectedImageIndex]?.dataUrl || m.bestMatch?.dataUrl || null,
            confidence: m.overallConfidence,
            matchReason: m.overallReason,
            matchSource: m.bestMatch?.status === 'auto_accepted' && m.overallConfidence === 'high'
              ? 'et-embedded'
              : m.geminiFallback ? 'gemini-fallback' : 'openai-vision',
            geminiFallback: m.geminiFallback || false
          }))
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setStatus(STATUS.SUBMIT_DONE);
      addToast(`Submitted ${confirmed.length} products to render queue!`, 'success');
    } catch (err) {
      setError(err.message);
      setStatus(STATUS.SUBMIT_ERROR);
      addToast(`Submit failed: ${err.message}`, 'error');
    }
  }, [matches, images, addToast]);

  // ── Reset everything ────────────────────────────────────────────
  const handleReset = useCallback(() => {
    // Abort any in-flight PDF-only matching
    if (pdfOnlyAbortRef.current) {
      pdfOnlyAbortRef.current.abort();
      pdfOnlyAbortRef.current = null;
    }
    setStatus(STATUS.IDLE);
    setPdfFile(null);
    setZipFile(null);
    setProducts([]);
    setImages([]);
    setMatches([]);
    setStats(null);
    setError(null);
    setProgressMsg('');
    setBatchId(null);
    setIsPdfOnlyMode(false);
    setPdfOnlyPaused(false);
  }, []);

  // ── Determine if matching can run ───────────────────────────────
  const canMatch = products.length > 0 && images.length > 0 &&
    status !== STATUS.MATCHING && status !== STATUS.SUBMITTING &&
    !isPdfOnlyMode;

  const canPdfOnlyMatch = pdfFile && !zipFile &&
    (status === STATUS.IDLE || status === STATUS.PDF_DONE || status === STATUS.PDF_ONLY_ERROR);

  const canSubmit = matches.some(m => m.confirmed) &&
    status !== STATUS.SUBMITTING;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="fr-panel-page vm-container">
      <div className="vm-header">
        <div>
          <h2><Layers size={20} /> Batch Product Matching</h2>
          <p className="fr-panel-sub">
            Upload a PDF catalog (and optionally a ZIP of images). AI will match each product to the best images.
          </p>
        </div>
        {status !== STATUS.IDLE && (
          <button className="vm-reset-btn" onClick={handleReset} title="Reset">
            <RefreshCw size={16} /> Reset
          </button>
        )}
      </div>

      {/* ── Upload Section ──────────────────────────────────────── */}
      <div className="vm-upload-section">
        <DropZone
          label="Upload PDF / WPS / ET Catalog"
          accept=".pdf,.wps,.et,.xls,.xlsx,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          icon={FileText}
          onFile={handlePdfUpload}
          disabled={status === STATUS.MATCHING || status === STATUS.SUBMITTING ||
            status === STATUS.PDF_ONLY_EXTRACTING || status === STATUS.PDF_ONLY_MATCHING ||
            status === STATUS.ET_EXTRACTING}
          currentFile={pdfFile}
        />
        <div className="vm-upload-arrow">
          <ArrowRight size={24} />
        </div>
        <DropZone
          label="Upload ZIP Images (optional)"
          accept=".zip,application/zip"
          icon={Archive}
          onFile={handleZipUpload}
          disabled={status === STATUS.MATCHING || status === STATUS.SUBMITTING ||
            status === STATUS.PDF_ONLY_EXTRACTING || status === STATUS.PDF_ONLY_MATCHING}
          currentFile={zipFile}
        />
      </div>

      {/* ── PDF-only / .et-only mode indicator ──────────────────── */}
      {pdfFile && !zipFile && status === STATUS.IDLE && (
        <div className="vm-pdf-only-prompt">
          <div className="vm-pdf-only-info">
            <File size={16} />
            <span>
              {pdfFile.name.toLowerCase().endsWith('.et')
                ? 'Only a .et spreadsheet selected. Click below to extract products and embedded images.'
                : 'Only a PDF file selected. You can either:'}
            </span>
          </div>
          <div className="vm-pdf-only-actions">
            <button className="vm-pdf-only-btn" onClick={handlePdfOnlyProcess}>
              <Sparkles size={14} />
              {pdfFile.name.toLowerCase().endsWith('.et') ? 'Extract .et Products & Images' : 'Run AI Per-Row Matching'}
              <small>
                {pdfFile.name.toLowerCase().endsWith('.et')
                  ? 'Extract product data + embedded images from spreadsheet cells'
                  : 'Extract products + page images, AI matches each row'}
              </small>
            </button>
            {!pdfFile.name.toLowerCase().endsWith('.et') && (
              <>
                <span className="vm-pdf-only-or">or</span>
                <span className="vm-pdf-only-hint">
                  Upload a ZIP file for standard image matching
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Batch Progress Bar (polling) ─────────────────────────── */}
      <BatchProgressBar
        batchId={batchId}
        status={status}
        setStatus={setStatus}
        setProgressMsg={setProgressMsg}
        addToast={addToast}
      />

      {/* ── ET Extraction Progress Bar (polling) ─────────────────── */}
      <EtProgressBar
        batchId={batchId}
        status={status}
        setStatus={setStatus}
        setProgressMsg={setProgressMsg}
        addToast={addToast}
        etProgress={etProgress}
        setEtProgress={setEtProgress}
      />

      {/* ── Progress / Error ────────────────────────────────────── */}
      {(status === STATUS.PDF_UPLOADING || status === STATUS.PDF_EXTRACTING ||
        status === STATUS.ZIP_UPLOADING || status === STATUS.ZIP_EXTRACTING ||
        status === STATUS.MATCHING || status === STATUS.SUBMITTING ||
        status === STATUS.PDF_ONLY_EXTRACTING || status === STATUS.PDF_ONLY_MATCHING ||
        status === STATUS.ET_EXTRACTING) && (
        <div className="vm-progress">
          {status === STATUS.ET_EXTRACTING ? (
            <>
              {/* Progress bar for .et extraction */}
              <div className="vm-et-progress-bar-wrap">
                <div className="vm-et-progress-bar">
                  <div
                    className="vm-et-progress-fill"
                    style={{ width: `${etProgress.percent || 0}%` }}
                  />
                </div>
                <span className="vm-et-progress-pct">{etProgress.percent || 0}%</span>
              </div>
              <span className="vm-et-progress-msg">{progressMsg}</span>
            </>
          ) : (
            <>
              <Loader2 size={18} className="fr-spin" />
              <span>{progressMsg}</span>
            </>
          )}
          {/* Pause button during PDF-only matching */}
          {status === STATUS.PDF_ONLY_MATCHING && !pdfOnlyPaused && (
            <button
              className="vm-pause-btn"
              onClick={handlePdfOnlyPause}
              title="Pause matching"
            >
              <X size={14} /> Pause
            </button>
          )}
        </div>
      )}

      {/* ── PDF-only paused state ───────────────────────────────── */}
      {pdfOnlyPaused && status === STATUS.PDF_ONLY_ERROR && (
        <div className="vm-pdf-only-prompt" style={{ marginTop: 12 }}>
          <div className="vm-pdf-only-info">
            <Info size={16} />
            <span>Matching paused. You can resume or restart.</span>
          </div>
          <div className="vm-pdf-only-actions">
            <button className="vm-pdf-only-btn" onClick={handlePdfOnlyResume}>
              <RefreshCw size={14} /> Resume Matching
              <small>Continue from where it left off</small>
            </button>
            <span className="vm-pdf-only-or">or</span>
            <button className="vm-reset-btn" onClick={handleReset} style={{ border: '1px solid #4a5260', padding: '8px 16px', borderRadius: 8, background: 'transparent', color: '#8e96a3', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
              Cancel & Reset
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="vm-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* ── PDF-only / .et mode badge ───────────────────────────── */}
      {isPdfOnlyMode && (status === STATUS.PDF_ONLY_DONE) && (
        <div className="vm-mode-badge vm-mode-pdf-only">
          <File size={14} />
          <span>
            {matches.length > 0 && matches[0]?.bestMatch?.status === 'auto_accepted' && matches[0]?.overallConfidence === 'high'
              ? '.et embedded image mode — Products matched to cell images'
              : 'PDF-only mode — AI matched products to page images'}
          </span>
        </div>
      )}

      {/* ── Products extracted ──────────────────────────────────── */}
      {products.length > 0 && status !== STATUS.MATCHING && (
        <div className="vm-products-summary">
          <h3>
            <FileText size={16} />
            Products Extracted ({products.length})
          </h3>
          <div className="vm-products-preview">
            {products.slice(0, 5).map((p, i) => (
              <span key={i} className="vm-product-chip">
                {p.name || p.productCode || `Product ${i + 1}`}
              </span>
            ))}
            {products.length > 5 && (
              <span className="vm-product-chip vm-chip-more">+{products.length - 5} more</span>
            )}
          </div>
        </div>
      )}

      {/* ── Images extracted ────────────────────────────────────── */}
      {images.length > 0 && status !== STATUS.MATCHING && (
        <div className="vm-images-summary">
          <h3>
            <ImagePlus size={16} />
            Images Extracted ({images.length})
          </h3>
          <div className="vm-images-preview">
            {images.slice(0, 8).map((img, i) => (
              <div key={i} className="vm-image-thumb">
                {img.dataUrl ? (
                  <img src={img.dataUrl} alt={img.name} />
                ) : (
                  <div className="vm-thumb-placeholder" />
                )}
              </div>
            ))}
            {images.length > 8 && (
              <div className="vm-image-thumb vm-thumb-more">+{images.length - 8}</div>
            )}
          </div>
        </div>
      )}

      {/* ── Run Matching Button (PDF+ZIP mode only) ─────────────── */}
      {canMatch && status !== STATUS.MATCH_DONE && !isPdfOnlyMode && (
        <button className="vm-match-btn" onClick={handleRunMatching}>
          <Search size={16} /> Run Vision Matching
          <small>{products.length} products × {images.length} images</small>
        </button>
      )}

      {/* ── PDF-only: Re-run matching button ────────────────────── */}
      {isPdfOnlyMode && status === STATUS.PDF_ONLY_DONE && products.length > 0 && images.length > 0 && (
        <button
          className="vm-match-btn vm-match-btn-pdf-only"
          onClick={() => handlePdfOnlyMatching(products, images)}
        >
          <Sparkles size={16} /> Re-run AI Per-Row Matching
          <small>{products.length} products × {images.length} page images</small>
        </button>
      )}

      {/* ── Stats Bar ───────────────────────────────────────────── */}
      {stats && <StatsBar stats={stats} />}

      {/* ── Product Match Results ───────────────────────────────── */}
      {matches.length > 0 && (
        <div className="vm-results">
          <h3>
            <Sparkles size={16} />
            Matching Results
            <span className="vm-result-count">
              {matches.filter(m => m.confirmed).length}/{matches.length} confirmed
            </span>
          </h3>

          <div className="vm-products-list">
            {matches.map((m, i) => (
              <ProductRowCard
                key={i}
                product={m.product}
                match={m}
                index={i}
                onConfirm={handleConfirm}
                onSelectImage={handleSelectImage}
              />
            ))}
          </div>

          {/* ── Submit Button ──────────────────────────────────── */}
          {canSubmit && (
            <div className="vm-submit-section">
              <div className="vm-submit-info">
                <Info size={14} />
                <span>
                  {matches.filter(m => m.confirmed).length} products confirmed.
                  {matches.filter(m => !m.confirmed).length > 0 &&
                    ` ${matches.filter(m => !m.confirmed).length} still need review.`}
                  Only confirmed products will be submitted.
                </span>
              </div>
              <button className="vm-submit-btn" onClick={handleSubmitToQueue}>
                <Zap size={16} />
                Submit {matches.filter(m => m.confirmed).length} Products to Render Queue
              </button>
            </div>
          )}

          {status === STATUS.SUBMIT_DONE && (
            <div className="vm-done">
              <CheckCircle2 size={20} />
              <span>All confirmed products submitted to render queue!</span>
            </div>
          )}
        </div>
      )}

      {/* ── PDF-only / .et mode footer ──────────────────────────── */}
      {isPdfOnlyMode && status === STATUS.PDF_ONLY_DONE && (
        <div className="vm-pdf-only-footer">
          <Info size={14} />
          <span>
            {matches.length > 0 && matches[0]?.bestMatch?.status === 'auto_accepted' && matches[0]?.overallConfidence === 'high'
              ? 'Products and images were extracted directly from the .et spreadsheet cells. All matches are pre-confirmed. Review and submit to proceed.'
              : `Products were matched to PDF page images using AI vision.
                 ${matches.filter(m => !m.confirmed).length > 0 &&
                   ` ${matches.filter(m => !m.confirmed).length} products need manual review.`}
                 Review and confirm each match before submitting.`}
          </span>
        </div>
      )}
    </div>
  );
}
