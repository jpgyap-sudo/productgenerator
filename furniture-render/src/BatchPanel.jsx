// ═══════════════════════════════════════════════════════════════════
//  BatchPanel.jsx — Vision-based PDF+ZIP matching tab
//                  with Gemini fallback for unmatched products
//
//  Workflow:
//    1. Upload PDF → extract product rows
//    2. Upload ZIP → extract images
//    3. Run vision matching (OpenAI fingerprints + ranking)
//    4. Gemini fallback for low/none confidence products
//    5. Display top 3 candidates per product
//    6. User confirms or changes selection
//    7. Submit confirmed matches to render queue
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
  ThumbsUp, ThumbsDown, ArrowRight, Layers
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

  // ── Handle PDF upload ───────────────────────────────────────────
  const handlePdfUpload = useCallback(async (file) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      addToast('Please select a PDF file', 'error');
      return;
    }
    setPdfFile(file);
    setError(null);
    setStatus(STATUS.PDF_UPLOADING);
    setProgressMsg('Uploading PDF...');

    try {
      // Read PDF as base64
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      setProgressMsg('Extracting product rows from PDF...');
      setStatus(STATUS.PDF_EXTRACTING);

      // Call the PDF extraction endpoint
      const res = await fetch(`${API_BASE}/api/agent/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfDataUrl: dataUrl,
          fileName: file.name
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const extractedProducts = data.products || data.items || [];
      if (extractedProducts.length === 0) {
        throw new Error('No products found in PDF');
      }

      setProducts(extractedProducts);
      setStatus(STATUS.PDF_DONE);
      addToast(`Extracted ${extractedProducts.length} products from PDF`, 'success');
    } catch (err) {
      setError(err.message);
      setStatus(STATUS.PDF_ERROR);
      addToast(`PDF extraction failed: ${err.message}`, 'error');
    }
  }, [addToast]);

  // ── Handle ZIP upload ───────────────────────────────────────────
  const handleZipUpload = useCallback(async (file) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      addToast('Please select a ZIP file', 'error');
      return;
    }
    setZipFile(file);
    setError(null);
    setStatus(STATUS.ZIP_UPLOADING);
    setProgressMsg('Uploading ZIP...');

    try {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      setProgressMsg('Extracting images from ZIP...');
      setStatus(STATUS.ZIP_EXTRACTING);

      // Call the ZIP extraction endpoint
      const res = await fetch(`${API_BASE}/api/queue/download-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zipDataUrl: dataUrl,
          fileName: file.name
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const extractedImages = data.images || [];
      if (extractedImages.length === 0) {
        throw new Error('No images found in ZIP');
      }

      setImages(extractedImages);
      setStatus(STATUS.ZIP_DONE);
      addToast(`Extracted ${extractedImages.length} images from ZIP`, 'success');
    } catch (err) {
      setError(err.message);
      setStatus(STATUS.ZIP_ERROR);
      addToast(`ZIP extraction failed: ${err.message}`, 'error');
    }
  }, [addToast]);

  // ── Run vision matching ─────────────────────────────────────────
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
            imageDataUrl: images[m.selectedImageIndex]?.dataUrl || null,
            confidence: m.overallConfidence,
            matchReason: m.overallReason,
            matchSource: m.geminiFallback ? 'gemini-fallback' : 'openai-vision',
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
    setStatus(STATUS.IDLE);
    setPdfFile(null);
    setZipFile(null);
    setProducts([]);
    setImages([]);
    setMatches([]);
    setStats(null);
    setError(null);
    setProgressMsg('');
  }, []);

  // ── Determine if matching can run ───────────────────────────────
  const canMatch = products.length > 0 && images.length > 0 &&
    status !== STATUS.MATCHING && status !== STATUS.SUBMITTING;

  const canSubmit = matches.some(m => m.confirmed) &&
    status !== STATUS.SUBMITTING;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="fr-panel-page vm-container">
      <div className="vm-header">
        <div>
          <h2><Layers size={20} /> Batch Product Matching</h2>
          <p className="fr-panel-sub">
            Upload a PDF catalog and a ZIP of product images. AI will match each product to the best images.
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
          label="Upload PDF Catalog"
          accept=".pdf,application/pdf"
          icon={FileText}
          onFile={handlePdfUpload}
          disabled={status === STATUS.MATCHING || status === STATUS.SUBMITTING}
          currentFile={pdfFile}
        />
        <div className="vm-upload-arrow">
          <ArrowRight size={24} />
        </div>
        <DropZone
          label="Upload ZIP Images"
          accept=".zip,application/zip"
          icon={Archive}
          onFile={handleZipUpload}
          disabled={status === STATUS.MATCHING || status === STATUS.SUBMITTING}
          currentFile={zipFile}
        />
      </div>

      {/* ── Progress / Error ────────────────────────────────────── */}
      {(status === STATUS.PDF_UPLOADING || status === STATUS.PDF_EXTRACTING ||
        status === STATUS.ZIP_UPLOADING || status === STATUS.ZIP_EXTRACTING ||
        status === STATUS.MATCHING || status === STATUS.SUBMITTING) && (
        <div className="vm-progress">
          <Loader2 size={18} className="fr-spin" />
          <span>{progressMsg}</span>
        </div>
      )}

      {error && (
        <div className="vm-error">
          <AlertCircle size={16} />
          <span>{error}</span>
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

      {/* ── Run Matching Button ─────────────────────────────────── */}
      {canMatch && status !== STATUS.MATCH_DONE && (
        <button className="vm-match-btn" onClick={handleRunMatching}>
          <Search size={16} /> Run Vision Matching
          <small>{products.length} products × {images.length} images</small>
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
    </div>
  );
}
