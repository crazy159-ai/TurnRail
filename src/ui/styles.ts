/**
 * 导航器全部样式。只存在于 Shadow DOM 内，:host 上 all:initial 做强隔离，
 * 颜色跟随 ChatGPT / 系统深浅色，视觉上保持半透明、低干扰。
 */
export const navigationCss = `
:host {
  all: initial;
}
.tn-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color-scheme: light dark;
  --tn-bg: rgba(255, 255, 255, 0.93);
  --tn-text: #0d0d0d;
  --tn-muted: #70707a;
  --tn-border: rgba(0, 0, 0, 0.09);
  --tn-accent: #10a37f;
  --tn-marker: rgba(0, 0, 0, 0.24);
  --tn-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
}
:host(.tn-dark) .tn-layer {
  --tn-bg: rgba(36, 36, 38, 0.94);
  --tn-text: #ececec;
  --tn-muted: #9a9aa2;
  --tn-border: rgba(255, 255, 255, 0.11);
  --tn-marker: rgba(255, 255, 255, 0.3);
  --tn-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
}
.tn-hidden {
  display: none !important;
}

/* ---------- 右侧 marker rail ---------- */
.tn-rail {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  pointer-events: auto;
}
.tn-marker {
  appearance: none;
  border: 0;
  padding: 0;
  margin: 0;
  position: absolute;
  right: 2px;
  width: 8px;
  border-radius: 999px;
  background: var(--tn-marker);
  opacity: 0.75;
  cursor: pointer;
  transition: width 0.15s ease, opacity 0.15s ease, background 0.15s ease;
}
.tn-marker:hover {
  opacity: 1;
  width: 13px;
  background: var(--tn-text);
}
.tn-marker.tn-active {
  width: 14px;
  opacity: 1;
  background: var(--tn-accent);
}
.tn-fail-dot {
  position: absolute;
  right: 4px;
  top: 50%;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(224, 100, 100, 0.75);
  cursor: default;
}

/* ---------- 展开目录面板 ---------- */
.tn-panel {
  position: absolute;
  right: 18px;
  top: 50%;
  width: 320px;
  max-height: 66vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--tn-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--tn-border);
  border-radius: 14px;
  box-shadow: var(--tn-shadow);
  pointer-events: auto;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-50%) translateX(10px);
  transition: opacity 0.16s ease, transform 0.16s ease, visibility 0.16s;
}
.tn-panel.tn-open {
  opacity: 1;
  visibility: visible;
  transform: translateY(-50%) translateX(0);
}
.tn-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
}
.tn-panel-title {
  flex: 1;
  font-weight: 600;
  color: var(--tn-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tn-count {
  color: var(--tn-muted);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.tn-icon-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--tn-muted);
  width: 24px;
  height: 24px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  padding: 0;
}
.tn-icon-btn:hover {
  background: var(--tn-border);
  color: var(--tn-text);
}
.tn-icon-btn.tn-on {
  color: var(--tn-accent);
}
.tn-search {
  margin: 0 12px 8px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--tn-border);
  background: transparent;
  color: var(--tn-text);
  outline: none;
  font: inherit;
}
.tn-search:focus {
  border-color: var(--tn-accent);
}
.tn-search::placeholder {
  color: var(--tn-muted);
}

.tn-health {
  margin: 0 12px 8px;
  padding: 8px 10px;
  border: 1px solid var(--tn-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--tn-bg) 82%, var(--tn-border));
  color: var(--tn-text);
}
.tn-health-hidden {
  display: none;
}
.tn-health-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
}
.tn-health-label {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
}
.tn-health-score {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.tn-health-conf {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--tn-border);
  color: var(--tn-muted);
}
.tn-health-conf-hidden {
  display: none;
}
.tn-health-message {
  font-size: 12px;
  line-height: 1.45;
}
.tn-health-reasons {
  margin-top: 4px;
  color: var(--tn-muted);
  font-size: 11px;
  line-height: 1.4;
}
.tn-health-reasons-hidden {
  display: none;
}
.tn-health-note {
  margin-top: 4px;
  color: var(--tn-muted);
  font-size: 10px;
  line-height: 1.35;
}
.tn-health-note-hidden {
  display: none;
}
.tn-health[data-level="healthy"] .tn-health-score {
  color: var(--tn-accent);
}
.tn-health[data-level="watch"] {
  border-color: rgba(184, 134, 11, 0.32);
}
.tn-health[data-level="watch"] .tn-health-score {
  color: #b3862d;
}
.tn-health[data-level="organize"] {
  border-color: rgba(211, 126, 25, 0.45);
}
.tn-health[data-level="organize"] .tn-health-score {
  color: #c66d16;
}
.tn-health[data-level="new-chat"] {
  border-color: rgba(210, 72, 72, 0.48);
  background: color-mix(in srgb, var(--tn-bg) 90%, rgba(210, 72, 72, 0.16));
}
.tn-health[data-level="new-chat"] .tn-health-score {
  color: #cf4d4d;
}

.tn-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 6px 8px;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}
.tn-item {
  appearance: none;
  border: 0;
  background: transparent;
  display: flex;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--tn-text);
  font: inherit;
}
.tn-item:hover {
  background: var(--tn-border);
}
.tn-item .tn-q {
  flex: none;
  font-size: 12px;
  color: var(--tn-muted);
  font-variant-numeric: tabular-nums;
}
.tn-item .tn-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tn-item .tn-flag {
  flex: none;
  font-size: 11px;
  color: var(--tn-muted);
  border: 1px solid var(--tn-border);
  border-radius: 4px;
  padding: 0 4px;
}
.tn-item.tn-active {
  background: color-mix(in srgb, var(--tn-accent) 14%, transparent);
}
.tn-item.tn-active .tn-q {
  color: var(--tn-accent);
  font-weight: 600;
}
.tn-empty {
  padding: 18px 12px;
  color: var(--tn-muted);
  text-align: center;
}
.tn-panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--tn-border);
}
.tn-status {
  flex: 1;
  min-height: 1em;
  color: var(--tn-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tn-load-btn {
  appearance: none;
  border: 1px solid var(--tn-border);
  background: transparent;
  color: var(--tn-text);
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.tn-load-btn:hover:not([disabled]) {
  border-color: var(--tn-accent);
  color: var(--tn-accent);
}
.tn-load-btn[disabled] {
  opacity: 0.5;
  cursor: default;
}
.tn-icon-btn[disabled] {
  opacity: 0.35;
  cursor: default;
}
.tn-icon-btn[disabled]:hover {
  background: transparent;
  color: var(--tn-muted);
}
.tn-cache-btn {
  font-size: 15px;
  line-height: 1;
}
.tn-cache-btn.tn-cached {
  color: #d99a2b;
}
:host(.tn-dark) .tn-cache-btn.tn-cached {
  color: #e7b455;
}

/* ---------- Checkpoint 星标（目录项内，低干扰） ---------- */
.tn-checkpoint-btn {
  flex: none;
  font-size: 13px;
  line-height: 1;
  color: var(--tn-muted);
  cursor: pointer;
  padding: 1px 3px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 120ms ease;
}
.tn-item:hover .tn-checkpoint-btn,
.tn-checkpoint-btn:focus-visible {
  opacity: 1;
}
.tn-checkpoint-btn.tn-checkpointed {
  opacity: 1;
  color: #d99a2b;
}
:host(.tn-dark) .tn-checkpoint-btn.tn-checkpointed {
  color: #e7b455;
}
.tn-checkpoint-btn:hover {
  background: var(--tn-border);
}
`
