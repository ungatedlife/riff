/**
 * Forged caret for the fullscreen riff room — a from-scratch take on the
 * Cursor-Smith setup in Rob's vault: a translucent 2px line caret with
 * serifs and a soft glow that *glides* to its new position instead of
 * jumping, blinking with a gentle fade only once it has settled.
 *
 * Honors prefers-reduced-motion: the glide collapses to an instant jump.
 *
 * Layout reads (coordsAtPos, getBoundingClientRect) are forbidden inside a
 * plugin's update() — CodeMirror throws and evicts the plugin. All measuring
 * therefore goes through view.requestMeasure, whose read phase runs after
 * the update cycle. The native caret is hidden via a class this plugin owns
 * (added on create, removed on destroy), so even if the plugin ever dies,
 * writing degrades to the native caret instead of no caret at all.
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Per-frame catch-up at small distances; ramps toward MAX on long jumps. */
const GLIDE_BASE = 0.3;
const GLIDE_MAX = 0.85;
/** Distance (px) over which the glide reaches full catch-up speed. */
const GLIDE_RAMP_PX = 320;
/** Close enough — snap to target and let the blink resume. */
const SETTLE_PX = 0.4;

/**
 * Marks that the forged caret is live (hides the native one). Lives on
 * scrollDOM: CodeMirror re-syncs the class lists of view.dom and contentDOM
 * from its facets, wiping foreign classes — the scroller it leaves alone.
 */
export const FORGED_CARET_LIVE_CLASS = "forged-caret-live";

interface CaretMeasure {
  x: number;
  y: number;
  h: number;
}

class ForgedCaret {
  private caret: HTMLDivElement;
  private x = 0;
  private y = 0;
  private h = 0;
  private targetX = 0;
  private targetY = 0;
  private targetH = 0;
  private raf = 0;
  private placed = false; // first placement teleports instead of gliding in
  private visible = false;
  private gliding = false;
  private reduceMotion: MediaQueryList;

  /** Reused measure request; keyed on the plugin so CM dedupes rapid updates. */
  private measureReq = {
    key: this as object,
    read: (): CaretMeasure | null => this.readCaret(),
    write: (m: CaretMeasure | null) => this.applyMeasure(m),
  };

  constructor(private view: EditorView) {
    this.caret = document.createElement("div");
    this.caret.className = "forged-caret forged-caret-hidden";
    this.caret.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.caret);
    view.scrollDOM.classList.add(FORGED_CARET_LIVE_CLASS);
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Initial position once the view has measured itself.
    view.requestMeasure(this.measureReq);
  }

  update(update: ViewUpdate) {
    if (
      update.selectionSet ||
      update.docChanged ||
      update.geometryChanged ||
      update.focusChanged
    ) {
      // No layout reads here — schedule them for the measure phase.
      this.view.requestMeasure(this.measureReq);
    }
  }

  /** Measure-phase read: where should the caret be? null = hide it. */
  private readCaret(): CaretMeasure | null {
    const { view } = this;
    const sel = view.state.selection.main;

    // The forged caret only stands in for a collapsed, focused cursor;
    // range selections keep drawSelection's highlight.
    if (!view.hasFocus || !sel.empty) return null;

    const coords = view.coordsAtPos(sel.head, sel.assoc || 1);
    if (!coords) return null; // off-viewport (scrolled away)

    const scrollRect = view.scrollDOM.getBoundingClientRect();
    return {
      x: coords.left - scrollRect.left + view.scrollDOM.scrollLeft,
      y: coords.top - scrollRect.top + view.scrollDOM.scrollTop,
      h: coords.bottom - coords.top,
    };
  }

  /** Measure-phase write: apply the measurement (DOM writes are safe here). */
  private applyMeasure(m: CaretMeasure | null) {
    if (!m) {
      this.hide();
      return;
    }

    this.targetX = m.x;
    this.targetY = m.y;
    this.targetH = m.h;

    if (!this.placed || !this.visible || this.reduceMotion.matches) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.h = this.targetH;
      this.placed = true;
      // Paint the teleport immediately — don't wait a frame for the RAF
      // loop (which background windows may throttle to a standstill).
      this.render();
    }

    this.show();
    this.schedule();
  }

  private show() {
    if (!this.visible) {
      this.visible = true;
      this.caret.classList.remove("forged-caret-hidden");
      this.restartBlink();
    }
  }

  private hide() {
    if (this.visible) {
      this.visible = false;
      this.caret.classList.add("forged-caret-hidden");
    }
  }

  private restartBlink() {
    // Re-trigger the blink animation from its "on" phase, the way a real
    // caret resets its blink on every move.
    this.caret.classList.remove("forged-caret-idle");
    void this.caret.offsetWidth; // reflow so the animation restarts
    this.caret.classList.add("forged-caret-idle");
  }

  private setGliding(gliding: boolean) {
    if (this.gliding === gliding) return;
    this.gliding = gliding;
    if (gliding) {
      // Solid while moving — a blinking caret mid-flight reads as flicker.
      this.caret.classList.remove("forged-caret-idle");
    } else {
      this.restartBlink();
    }
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.step();
    });
  }

  private step() {
    if (!this.visible) return;

    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dh = this.targetH - this.h;
    const dist = Math.hypot(dx, dy);

    if (dist <= SETTLE_PX && Math.abs(dh) <= SETTLE_PX) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.h = this.targetH;
      this.render();
      this.setGliding(false);
      return; // settled — no more frames until the next measure
    }

    this.setGliding(true);
    const k = Math.min(GLIDE_MAX, GLIDE_BASE + (dist / GLIDE_RAMP_PX) * GLIDE_MAX);
    this.x += dx * k;
    this.y += dy * k;
    this.h += dh * k;
    this.render();
    this.schedule();
  }

  private render() {
    this.caret.style.transform = `translate(${this.x}px, ${this.y}px)`;
    this.caret.style.height = `${this.h}px`;
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.view.scrollDOM.classList.remove(FORGED_CARET_LIVE_CLASS);
    this.caret.remove();
  }
}

export function forgedCaret() {
  return [ViewPlugin.fromClass(ForgedCaret)];
}
