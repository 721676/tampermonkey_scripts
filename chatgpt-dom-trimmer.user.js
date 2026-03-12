// ==UserScript==
// @name         ChatGPT DOM Trimmer
// @namespace    https://github.com/MYLOGIN/tampermonkey_scripts
// @version      1.1.0
// @description  Авто-обрезка старых сообщений в чате ChatGPT + перемещаемая настраиваемая панель
// @author       you
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @exclude      https://chatgpt.com/gpts/editor*
// @exclude      https://chatgpt.com/codex*
// @exclude      https://chat.openai.com/gpts/editor*
// @exclude      https://chat.openai.com/codex*
// @downloadURL  https://raw.githubusercontent.com/MYLOGIN/tampermonkey_scripts/main/chatgpt-dom-trimmer.user.js
// @updateURL    https://raw.githubusercontent.com/MYLOGIN/tampermonkey_scripts/main/chatgpt-dom-trimmer.meta.js
// @homepageURL  https://github.com/MYLOGIN/tampermonkey_scripts
// @supportURL   https://github.com/MYLOGIN/tampermonkey_scripts/issues
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const EXCLUDED_PATHS = [
        "/gpts/editor",
        "/codex",
    ];

    function isExcludedPage() {
        const path = window.location.pathname.replace(/\/+$/, "");
        return EXCLUDED_PATHS.some(excluded =>
            path === excluded || path.startsWith(excluded + "/")
        );
    }

    if (isExcludedPage()) {
        console.log("[GPT DOM Trimmer] excluded page:", window.location.pathname);
        return;
    }

    console.log("[GPT DOM Trimmer] script loaded");

    const STORAGE_KEY = "gptDomTrimSettings_v3";
    const STUB_CLASS = "gpt-dom-trim-stub";

    const defaultSettings = {
        enabled: true,
        keepLast: 5,

        panelX: null,
        panelY: 12,
        menuOpen: false,

        opacity: 96, // 10..100
        backgroundColor: "#2b2d31",
    };

    let settings = loadSettings();
    let observer = null;
    let trimScheduled = false;
    let turnsContainer = null;

    let ui = {
        wrapper: null,
        panel: null,
        menu: null,
        toggle: null,
        input: null,
        opacityRange: null,
        opacityValue: null,
        arrowBtn: null,
        colorInput: null,
        presetButtons: [],
        eyeDropperBtn: null,
    };

    let dragging = {
        active: false,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
    };

    function clamp(num, min, max) {
        return Math.max(min, Math.min(max, num));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...defaultSettings };

            const parsed = JSON.parse(raw);

            return {
                enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultSettings.enabled,
                keepLast: Number.isFinite(+parsed.keepLast) ? clamp(+parsed.keepLast, 2, 200) : defaultSettings.keepLast,
                panelX: Number.isFinite(+parsed.panelX) ? +parsed.panelX : defaultSettings.panelX,
                panelY: Number.isFinite(+parsed.panelY) ? +parsed.panelY : defaultSettings.panelY,
                menuOpen: typeof parsed.menuOpen === "boolean" ? parsed.menuOpen : defaultSettings.menuOpen,
                opacity: Number.isFinite(+parsed.opacity) ? clamp(+parsed.opacity, 10, 100) : defaultSettings.opacity,
                backgroundColor: isValidCssColor(parsed.backgroundColor) ? parsed.backgroundColor : defaultSettings.backgroundColor,
            };
        } catch (e) {
            console.warn("[GPT DOM Trimmer] loadSettings error", e);
            return { ...defaultSettings };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn("[GPT DOM Trimmer] saveSettings error", e);
        }
    }

    function isValidCssColor(value) {
        if (typeof value !== "string" || !value.trim()) return false;
        const s = new Option().style;
        s.color = "";
        s.color = value;
        return !!s.color;
    }

    function hexToRgb(hex) {
        if (!hex || typeof hex !== "string") return null;
        let h = hex.trim().replace("#", "");
        if (h.length === 3) {
            h = h.split("").map(ch => ch + ch).join("");
        }
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    function rgbStringToRgb(str) {
        if (typeof str !== "string") return null;
        const m = str.match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const parts = m[1].split(",").map(v => parseFloat(v.trim()));
        if (parts.length < 3) return null;
        return { r: parts[0], g: parts[1], b: parts[2] };
    }

    function normalizeColorToHex(color) {
        if (!color) return defaultSettings.backgroundColor;
        if (color.startsWith("#")) {
            const rgb = hexToRgb(color);
            if (!rgb) return defaultSettings.backgroundColor;
            return "#" + [rgb.r, rgb.g, rgb.b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
        }

        const probe = document.createElement("div");
        probe.style.color = color;
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        document.body.removeChild(probe);

        const rgb = rgbStringToRgb(computed);
        if (!rgb) return defaultSettings.backgroundColor;

        return "#" + [rgb.r, rgb.g, rgb.b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
    }

    function relativeLuminance(rgb) {
        const srgb = [rgb.r, rgb.g, rgb.b].map(v => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    }

    function getContrastTextColor(bgHex) {
        const rgb = hexToRgb(normalizeColorToHex(bgHex));
        if (!rgb) return "#f5f7fb";
        return relativeLuminance(rgb) > 0.58 ? "#111318" : "#f5f7fb";
    }

    function mixColor(hex, amount, targetHex) {
        const rgb = hexToRgb(normalizeColorToHex(hex));
        const trg = hexToRgb(normalizeColorToHex(targetHex));
        if (!rgb || !trg) return hex;

        const mix = (a, b) => Math.round(a + (b - a) * amount);

        return "#" + [
            mix(rgb.r, trg.r),
            mix(rgb.g, trg.g),
            mix(rgb.b, trg.b),
        ].map(v => v.toString(16).padStart(2, "0")).join("");
    }

    function rgbaFromHex(hex, alpha) {
        const rgb = hexToRgb(normalizeColorToHex(hex));
        if (!rgb) return `rgba(43,45,49,${alpha})`;
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    function getThemeTokens(baseHex, opacityPercent) {
        const bg = normalizeColorToHex(baseHex);
        const rgb = hexToRgb(bg);
        const lum = rgb ? relativeLuminance(rgb) : 0.15;
        const isLight = lum > 0.58;

        const alpha = clamp(opacityPercent, 10, 100) / 100;

        const text = isLight ? "#101216" : "#f5f7fb";
        const textMuted = isLight ? "rgba(16,18,22,.78)" : "rgba(245,247,251,.82)";

        // Поверхности: base -> surface -> control -> border.
        // Идея похожа на стандартные подходы Win/macOS:
        // есть основной материал, есть приподнятая поверхность, есть ещё более контрастные controls и отдельная граница.
        const surface = isLight ? mixColor(bg, 0.05, "#f5f6f8") : mixColor(bg, 0.10, "#ffffff");
        const menuSurface = isLight ? mixColor(bg, 0.08, "#f4f5f7") : mixColor(bg, 0.13, "#ffffff");
        const controlFill = isLight ? mixColor(bg, 0.16, "#edf0f4") : mixColor(bg, 0.12, "#0f1115");
        const controlFillAlt = isLight ? mixColor(bg, 0.10, "#ffffff") : mixColor(bg, 0.18, "#0b0d10");

        const border = isLight ? mixColor(bg, 0.28, "#6b7280") : mixColor(bg, 0.28, "#d1d5db");
        const borderSoft = isLight ? mixColor(bg, 0.17, "#8d96a3") : mixColor(bg, 0.18, "#aeb6c2");

        const shadow = isLight
            ? "0 10px 28px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)"
            : "0 10px 28px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.22)";

        const panelBg = rgbaFromHex(surface, alpha);
        const menuBg = rgbaFromHex(menuSurface, alpha);
        const controlBg = rgbaFromHex(controlFill, Math.min(1, alpha * 0.96));
        const controlBgAlt = rgbaFromHex(controlFillAlt, Math.min(1, alpha * 0.98));

        const arrowBg = rgbaFromHex(surface, alpha);
        const inputBg = rgbaFromHex(controlFillAlt, Math.min(1, alpha * 0.98));

        return {
            bg,
            isLight,
            alpha,
            text,
            textMuted,
            surface,
            menuSurface,
            controlFill,
            controlFillAlt,
            border,
            borderSoft,
            shadow,
            panelBg,
            menuBg,
            controlBg,
            controlBgAlt,
            arrowBg,
            inputBg,
        };
    }

    function injectStyles() {
        const css = `
.${STUB_CLASS} {
  font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size: 11px;
  color: #9ca3af;
  padding: 4px 8px;
  margin: 4px 0;
  border-left: 2px dashed #4b5563;
  opacity: 0.9;
}

#gpt-dom-trim-wrapper {
  position: fixed;
  z-index: 999999;
  left: 12px;
  top: 12px;
  user-select: none;
}

#gpt-dom-trim-panel {
  position: relative;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 14px;
  font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size: 12px;
  cursor: grab;
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
  transition: box-shadow .16s ease, background-color .16s ease, color .16s ease, border-color .16s ease;
}

#gpt-dom-trim-panel.dragging {
  cursor: grabbing;
}

#gpt-dom-trim-menu {
  margin-top: 18px;
  padding: 12px 14px;
  border-radius: 14px;
  font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size: 12px;
  display: none;
  min-width: 320px;
  backdrop-filter: blur(12px) saturate(1.08);
  -webkit-backdrop-filter: blur(12px) saturate(1.08);
  transition: box-shadow .16s ease, background-color .16s ease, color .16s ease, border-color .16s ease;
}

#gpt-dom-trim-wrapper.menu-open #gpt-dom-trim-menu {
  display: block;
}

#gpt-dom-trim-label,
#gpt-dom-trim-input-label {
  white-space: nowrap;
}

#gpt-dom-trim-label {
  font-weight: 600;
}

#gpt-dom-trim-input-label {
  opacity: .95;
}

#gpt-dom-trim-input {
  width: 42px;
  padding: 4px 5px;
  border-radius: 8px;
  font-size: 12px;
  text-align: center;
  outline: none;
  box-sizing: border-box;
}

.gpt-dom-trim-btn {
  cursor: pointer;
  padding: 0 8px;
  min-width: 30px;
  height: 28px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 26px;
  box-sizing: border-box;
}

#gpt-dom-trim-toggle {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 999px;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
  flex: 0 0 auto;
  box-sizing: border-box;
}

#gpt-dom-trim-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  transition: transform .15s ease, background-color .15s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
}

#gpt-dom-trim-toggle.on #gpt-dom-trim-toggle-knob {
  transform: translateX(20px);
}

#gpt-dom-trim-arrow {
  position: absolute;
  left: 50%;
  bottom: -13px;
  transform: translateX(-50%);
  width: 30px;
  height: 18px;
  border-radius: 0 0 11px 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform .15s ease, background-color .15s ease, color .15s ease, border-color .15s ease;
  box-sizing: border-box;
}

#gpt-dom-trim-arrow svg {
  width: 12px;
  height: 12px;
  transition: transform .18s ease;
}

#gpt-dom-trim-wrapper.menu-open #gpt-dom-trim-arrow svg {
  transform: rotate(180deg);
}

.gpt-dom-trim-menu-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.gpt-dom-trim-menu-row:last-child {
  margin-bottom: 0;
}

.gpt-dom-trim-menu-title {
  min-width: 82px;
  font-weight: 600;
  white-space: nowrap;
}

#gpt-dom-trim-opacity {
  width: 100%;
  min-width: 160px;
}

#gpt-dom-trim-opacity-value {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.gpt-dom-trim-color-preset {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  cursor: pointer;
  padding: 0;
  flex: 0 0 auto;
  box-sizing: border-box;
  background-clip: padding-box;
}

.gpt-dom-trim-color-preset[data-color="#202123"] {
  background: #202123 !important;
}
.gpt-dom-trim-color-preset[data-color="#343541"] {
  background: #343541 !important;
}
.gpt-dom-trim-color-preset[data-color="#f2f2f2"] {
  background: #f2f2f2 !important;
}

#gpt-dom-trim-color-input {
  width: 34px;
  height: 24px;
  padding: 0;
  border-radius: 7px;
  cursor: pointer;
  box-sizing: border-box;
  background: transparent;
}

#gpt-dom-trim-eyedropper {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  box-sizing: border-box;
}

#gpt-dom-trim-eyedropper[disabled] {
  opacity: .5;
  cursor: not-allowed;
}

.gpt-dom-trim-no-drag,
.gpt-dom-trim-no-drag * {
  cursor: auto;
}

#gpt-dom-trim-panel button,
#gpt-dom-trim-menu button,
#gpt-dom-trim-panel input,
#gpt-dom-trim-menu input,
#gpt-dom-trim-panel label,
#gpt-dom-trim-menu label {
  user-select: none;
}

#gpt-dom-trim-panel button,
#gpt-dom-trim-menu button,
#gpt-dom-trim-panel input,
#gpt-dom-trim-menu input {
  outline: none;
}

#gpt-dom-trim-color-input::-webkit-color-swatch-wrapper {
  padding: 2px;
}
#gpt-dom-trim-color-input::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
#gpt-dom-trim-color-input::-moz-color-swatch {
  border: none;
  border-radius: 4px;
}
`;
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }

    function applyPanelTheme() {
        if (!ui.wrapper || !ui.panel || !ui.menu) return;

        const t = getThemeTokens(settings.backgroundColor, settings.opacity);

        ui.panel.style.background = t.panelBg;
        ui.panel.style.color = t.text;
        ui.panel.style.border = `1px solid ${t.borderSoft}`;
        ui.panel.style.boxShadow = t.shadow;

        ui.menu.style.background = t.menuBg;
        ui.menu.style.color = t.text;
        ui.menu.style.border = `1px solid ${t.borderSoft}`;
        ui.menu.style.boxShadow = t.shadow;

        const commonButtons = ui.wrapper.querySelectorAll(".gpt-dom-trim-btn, #gpt-dom-trim-eyedropper");
        commonButtons.forEach(el => {
            el.style.background = t.controlBg;
            el.style.color = t.text;
            el.style.border = `1px solid ${t.border}`;
        });

        if (ui.input) {
            ui.input.style.background = t.inputBg;
            ui.input.style.color = t.text;
            ui.input.style.border = `1px solid ${t.border}`;
        }

        if (ui.arrowBtn) {
            ui.arrowBtn.style.background = t.arrowBg;
            ui.arrowBtn.style.color = t.text;
            ui.arrowBtn.style.border = `1px solid ${t.borderSoft}`;
            ui.arrowBtn.style.boxShadow = t.shadow;
        }

        if (ui.opacityValue) {
            ui.opacityValue.textContent = `${settings.opacity}%`;
            ui.opacityValue.style.color = t.textMuted;
        }

        if (ui.opacityRange) {
            ui.opacityRange.style.accentColor = t.isLight ? "#1a1d22" : "#f2f4f8";
        }

        if (ui.toggle) {
            ui.toggle.style.background = settings.enabled ? "#22c55e" : t.controlBgAlt;
            ui.toggle.style.border = settings.enabled ? "1px solid rgba(34,197,94,.55)" : `1px solid ${t.border}`;
            const knob = ui.toggle.querySelector("#gpt-dom-trim-toggle-knob");
            if (knob) {
                knob.style.background = settings.enabled ? "#f8fafc" : (t.isLight ? "#ffffff" : "#f4f6fb");
            }
        }

        if (ui.colorInput) {
            ui.colorInput.value = normalizeColorToHex(settings.backgroundColor);
            ui.colorInput.style.border = `1px solid ${t.border}`;
            ui.colorInput.style.background = t.controlBg;
        }

        if (ui.presetButtons && ui.presetButtons.length) {
            const current = normalizeColorToHex(settings.backgroundColor);
            ui.presetButtons.forEach(btn => {
                const preset = normalizeColorToHex(btn.dataset.color);
                const active = preset === current;
                btn.style.border = active ? `2px solid ${t.text}` : `1px solid ${t.border}`;
                btn.style.boxShadow = active ? `0 0 0 2px ${rgbaFromHex(t.bg, 0.18)}` : "none";
            });
        }

        const labels = ui.wrapper.querySelectorAll("#gpt-dom-trim-label, #gpt-dom-trim-input-label, .gpt-dom-trim-menu-title");
        labels.forEach(el => {
            el.style.color = t.text;
        });
    }

    function applyMenuState() {
        if (!ui.wrapper) return;
        ui.wrapper.classList.toggle("menu-open", !!settings.menuOpen);
    }

    function updateToggleUI() {
        if (!ui.toggle) return;
        ui.toggle.classList.toggle("on", !!settings.enabled);
        applyPanelTheme();
    }

    function updateKeepInputUI() {
        if (ui.input) {
            ui.input.value = String(settings.keepLast);
        }
    }

    function updateOpacityUI() {
        if (ui.opacityRange) {
            ui.opacityRange.value = String(settings.opacity);
        }
        if (ui.opacityValue) {
            ui.opacityValue.textContent = `${settings.opacity}%`;
        }
        applyPanelTheme();
    }

    function ensurePositionDefaults() {
        if (!ui.wrapper) return;

        if (settings.panelX == null) {
            const margin = 12;
            const desiredRightOffset = 200;
            const rect = ui.wrapper.getBoundingClientRect();
            const x = window.innerWidth - rect.width - desiredRightOffset;
            settings.panelX = Math.max(margin, x);
        }

        if (!Number.isFinite(settings.panelY)) {
            settings.panelY = 12;
        }

        clampAndApplyPosition(false);
    }

    function clampAndApplyPosition(shouldSave = false) {
        if (!ui.wrapper) return;

        const margin = 8;
        const rect = ui.wrapper.getBoundingClientRect();

        const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxY = Math.max(margin, window.innerHeight - rect.height - margin);

        settings.panelX = clamp(Number.isFinite(settings.panelX) ? settings.panelX : 12, margin, maxX);
        settings.panelY = clamp(Number.isFinite(settings.panelY) ? settings.panelY : 12, margin, maxY);

        ui.wrapper.style.left = `${settings.panelX}px`;
        ui.wrapper.style.top = `${settings.panelY}px`;

        if (shouldSave) saveSettings();
    }

    function isInteractiveTarget(target) {
        if (!(target instanceof Element)) return false;
        return !!target.closest("button, input, select, textarea, label, a, .gpt-dom-trim-no-drag");
    }

    function onDragStart(e) {
        if (e.button !== 0) return;
        if (isInteractiveTarget(e.target)) return;

        dragging.active = true;
        dragging.startX = e.clientX;
        dragging.startY = e.clientY;
        dragging.originX = settings.panelX ?? 12;
        dragging.originY = settings.panelY ?? 12;

        ui.panel.classList.add("dragging");

        document.addEventListener("pointermove", onDragMove);
        document.addEventListener("pointerup", onDragEnd);
    }

    function onDragMove(e) {
        if (!dragging.active) return;

        settings.panelX = dragging.originX + (e.clientX - dragging.startX);
        settings.panelY = dragging.originY + (e.clientY - dragging.startY);

        clampAndApplyPosition(false);
    }

    function onDragEnd() {
        if (!dragging.active) return;
        dragging.active = false;

        ui.panel.classList.remove("dragging");

        document.removeEventListener("pointermove", onDragMove);
        document.removeEventListener("pointerup", onDragEnd);

        clampAndApplyPosition(true);
    }

    function createIconChevron() {
        return `
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.116l3.71-3.886a.75.75 0 1 1 1.08 1.04l-4.25 4.45a.75.75 0 0 1-1.08 0l-4.25-4.45a.75.75 0 0 1 .02-1.06Z"></path>
            </svg>
        `;
    }

    function createControlPanel() {
        if (document.getElementById("gpt-dom-trim-wrapper")) return;

        const wrapper = document.createElement("div");
        wrapper.id = "gpt-dom-trim-wrapper";

        const panel = document.createElement("div");
        panel.id = "gpt-dom-trim-panel";

        const label = document.createElement("span");
        label.id = "gpt-dom-trim-label";
        label.textContent = "Авто-обрезка старых сообщений";

        const toggle = document.createElement("button");
        toggle.id = "gpt-dom-trim-toggle";
        toggle.title = "Вкл/выкл авто-обрезку";
        toggle.className = "gpt-dom-trim-no-drag";

        const knob = document.createElement("span");
        knob.id = "gpt-dom-trim-toggle-knob";
        toggle.appendChild(knob);

        const countLabel = document.createElement("span");
        countLabel.id = "gpt-dom-trim-input-label";
        countLabel.textContent = "Оставлять:";

        const btnDec = document.createElement("button");
        btnDec.className = "gpt-dom-trim-btn gpt-dom-trim-no-drag";
        btnDec.textContent = "−";

        const input = document.createElement("input");
        input.id = "gpt-dom-trim-input";
        input.className = "gpt-dom-trim-no-drag";
        input.type = "number";
        input.min = "2";
        input.max = "200";
        input.step = "1";
        input.value = String(settings.keepLast);

        const btnInc = document.createElement("button");
        btnInc.className = "gpt-dom-trim-btn gpt-dom-trim-no-drag";
        btnInc.textContent = "+";

        const arrowBtn = document.createElement("button");
        arrowBtn.id = "gpt-dom-trim-arrow";
        arrowBtn.className = "gpt-dom-trim-no-drag";
        arrowBtn.type = "button";
        arrowBtn.title = "Открыть/закрыть меню";
        arrowBtn.innerHTML = createIconChevron();

        const menu = document.createElement("div");
        menu.id = "gpt-dom-trim-menu";

        const rowOpacity = document.createElement("div");
        rowOpacity.className = "gpt-dom-trim-menu-row";

        const opacityTitle = document.createElement("span");
        opacityTitle.className = "gpt-dom-trim-menu-title";
        opacityTitle.textContent = "Прозрачность";

        const opacityRange = document.createElement("input");
        opacityRange.id = "gpt-dom-trim-opacity";
        opacityRange.type = "range";
        opacityRange.min = "10";
        opacityRange.max = "100";
        opacityRange.step = "1";
        opacityRange.value = String(settings.opacity);
        opacityRange.className = "gpt-dom-trim-no-drag";

        const opacityValue = document.createElement("span");
        opacityValue.id = "gpt-dom-trim-opacity-value";
        opacityValue.textContent = `${settings.opacity}%`;

        rowOpacity.appendChild(opacityTitle);
        rowOpacity.appendChild(opacityRange);
        rowOpacity.appendChild(opacityValue);

        const rowColor = document.createElement("div");
        rowColor.className = "gpt-dom-trim-menu-row";

        const colorTitle = document.createElement("span");
        colorTitle.className = "gpt-dom-trim-menu-title";
        colorTitle.textContent = "Цвет фона";

        const preset1 = document.createElement("button");
        preset1.type = "button";
        preset1.className = "gpt-dom-trim-color-preset gpt-dom-trim-no-drag";
        preset1.dataset.color = "#202123";
        preset1.title = "Темный ChatGPT";

        const preset2 = document.createElement("button");
        preset2.type = "button";
        preset2.className = "gpt-dom-trim-color-preset gpt-dom-trim-no-drag";
        preset2.dataset.color = "#343541";
        preset2.title = "Серый ChatGPT";

        const preset3 = document.createElement("button");
        preset3.type = "button";
        preset3.className = "gpt-dom-trim-color-preset gpt-dom-trim-no-drag";
        preset3.dataset.color = "#f2f2f2";
        preset3.title = "Светлый";

        const colorInput = document.createElement("input");
        colorInput.id = "gpt-dom-trim-color-input";
        colorInput.className = "gpt-dom-trim-no-drag";
        colorInput.type = "color";
        colorInput.value = normalizeColorToHex(settings.backgroundColor);
        colorInput.title = "Выбрать цвет вручную";

        const eyeDropperBtn = document.createElement("button");
        eyeDropperBtn.id = "gpt-dom-trim-eyedropper";
        eyeDropperBtn.className = "gpt-dom-trim-no-drag";
        eyeDropperBtn.type = "button";
        eyeDropperBtn.textContent = "Пипетка";
        eyeDropperBtn.title = "Выбрать цвет с экрана";
        if (!("EyeDropper" in window)) {
            eyeDropperBtn.disabled = true;
            eyeDropperBtn.title = "EyeDropper API не поддерживается в этом браузере";
        }

        rowColor.appendChild(colorTitle);
        rowColor.appendChild(preset1);
        rowColor.appendChild(preset2);
        rowColor.appendChild(preset3);
        rowColor.appendChild(colorInput);
        rowColor.appendChild(eyeDropperBtn);

        menu.appendChild(rowOpacity);
        menu.appendChild(rowColor);

        panel.appendChild(label);
        panel.appendChild(toggle);
        panel.appendChild(countLabel);
        panel.appendChild(btnDec);
        panel.appendChild(input);
        panel.appendChild(btnInc);
        panel.appendChild(arrowBtn);

        wrapper.appendChild(panel);
        wrapper.appendChild(menu);
        document.body.appendChild(wrapper);

        ui = {
            wrapper,
            panel,
            menu,
            toggle,
            input,
            opacityRange,
            opacityValue,
            arrowBtn,
            colorInput,
            presetButtons: [preset1, preset2, preset3],
            eyeDropperBtn,
        };

        function applyKeep(v) {
            if (!Number.isFinite(v)) return;
            settings.keepLast = clamp(v, 2, 200);
            updateKeepInputUI();
            saveSettings();
            scheduleTrim();
        }

        function setBackgroundColor(color) {
            settings.backgroundColor = normalizeColorToHex(color);
            saveSettings();
            applyPanelTheme();
        }

        toggle.addEventListener("click", () => {
            settings.enabled = !settings.enabled;
            saveSettings();
            updateToggleUI();

            if (settings.enabled) {
                scheduleTrim();
            } else {
                restoreTrimmedMessages();
            }
        });

        btnDec.addEventListener("click", () => applyKeep(settings.keepLast - 1));
        btnInc.addEventListener("click", () => applyKeep(settings.keepLast + 1));

        input.addEventListener("input", () => {
            const v = parseInt(input.value, 10);
            if (Number.isFinite(v)) applyKeep(v);
        });

        input.addEventListener("change", () => {
            const v = parseInt(input.value, 10);
            applyKeep(Number.isFinite(v) ? v : settings.keepLast);
        });

        arrowBtn.addEventListener("click", () => {
            settings.menuOpen = !settings.menuOpen;
            saveSettings();
            applyMenuState();
            requestAnimationFrame(() => clampAndApplyPosition(false));
        });

        opacityRange.addEventListener("input", () => {
            settings.opacity = clamp(parseInt(opacityRange.value, 10) || 96, 10, 100);
            updateOpacityUI();
            saveSettings();
        });

        ui.presetButtons.forEach(btn => {
            btn.addEventListener("click", () => setBackgroundColor(btn.dataset.color));
        });

        colorInput.addEventListener("input", () => {
            setBackgroundColor(colorInput.value);
        });

        eyeDropperBtn.addEventListener("click", async () => {
            if (!("EyeDropper" in window)) return;
            try {
                const eyeDropper = new window.EyeDropper();
                const result = await eyeDropper.open();
                if (result && result.sRGBHex) {
                    setBackgroundColor(result.sRGBHex);
                }
            } catch (err) {
                console.log("[GPT DOM Trimmer] EyeDropper cancelled or failed", err);
            }
        });

        panel.addEventListener("pointerdown", onDragStart);
        menu.addEventListener("pointerdown", onDragStart);

        updateKeepInputUI();
        updateToggleUI();
        updateOpacityUI();
        applyMenuState();
        applyPanelTheme();

        requestAnimationFrame(() => {
            ensurePositionDefaults();
            applyPanelTheme();
        });
    }

    function getAllTurns() {
        const root = turnsContainer || document;
        let turns = root.querySelectorAll(`[data-testid="conversation-turn"], .${STUB_CLASS}`);
        if (!turns || !turns.length) {
            turns = root.querySelectorAll(`[data-message-author-role], .${STUB_CLASS}`);
        }
        return Array.from(turns);
    }

    function makeStub(original, index) {
        const stub = document.createElement("div");
        stub.className = STUB_CLASS;
        stub.textContent = `… старое сообщение #${index + 1} свернуто для ускорения чата`;

        try {
            stub.dataset.originalHtml = original.outerHTML;
        } catch (e) {
            console.warn("[GPT DOM Trimmer] could not save original HTML", e);
        }

        return stub;
    }

    function restoreStub(stub) {
        const html = stub.dataset.originalHtml;
        if (!html) return;

        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();

        const restored = tpl.content.firstElementChild;
        if (restored) {
            stub.replaceWith(restored);
        }
    }

    function restoreTrimmedMessages() {
        const stubs = Array.from(document.querySelectorAll(`.${STUB_CLASS}`));
        if (!stubs.length) return;

        stubs.forEach(stub => {
            try {
                restoreStub(stub);
            } catch (e) {
                console.warn("[GPT DOM Trimmer] restore failed", e);
            }
        });
    }

    function trimMessages() {
        if (!document.body) return;

        if (!settings.enabled) {
            restoreTrimmedMessages();
            return;
        }

        const turns = getAllTurns();
        if (!turns.length) return;

        const keep = clamp(settings.keepLast || defaultSettings.keepLast, 2, 200);
        const currentAll = getAllTurns();
        const extra = currentAll.length - keep;

        if (extra <= 0) return;

        for (let i = 0; i < extra; i++) {
            const el = currentAll[i];
            if (!el || el.classList.contains(STUB_CLASS)) continue;

            const stub = makeStub(el, i);
            el.replaceWith(stub);
        }
    }

    function scheduleTrim() {
        if (trimScheduled) return;
        trimScheduled = true;

        setTimeout(() => {
            trimScheduled = false;
            trimMessages();
        }, 200);
    }

    function initObserver() {
        turnsContainer =
            document.querySelector('[data-testid="conversation-turns"]') ||
            document.querySelector("main");

        if (!turnsContainer) {
            console.log("[GPT DOM Trimmer] no turns container yet, retrying...");
            setTimeout(initObserver, 1000);
            return;
        }

        if (observer) observer.disconnect();

        observer = new MutationObserver((mutations) => {
            let changed = false;
            for (const m of mutations) {
                if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
                    changed = true;
                    break;
                }
            }
            if (changed) scheduleTrim();
        });

        observer.observe(turnsContainer, {
            childList: true,
            subtree: true,
        });

        scheduleTrim();
    }

    function applySettingsFromStorage() {
        const fresh = loadSettings();
        settings = { ...fresh };

        updateKeepInputUI();
        updateToggleUI();
        updateOpacityUI();
        applyMenuState();
        applyPanelTheme();
        clampAndApplyPosition(false);

        if (settings.enabled) {
            scheduleTrim();
        } else {
            restoreTrimmedMessages();
        }
    }

    function initStorageSync() {
        window.addEventListener("storage", (e) => {
            if (e.key !== STORAGE_KEY) return;
            applySettingsFromStorage();
        });
    }

    function initResizeHandler() {
        window.addEventListener("resize", () => {
            clampAndApplyPosition(false);
        });
    }

    function init() {
        injectStyles();
        createControlPanel();
        initObserver();
        initStorageSync();
        initResizeHandler();
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        window.addEventListener("DOMContentLoaded", init);
    }
})();