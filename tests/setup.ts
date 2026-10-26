// Supplies the layout observer missing from jsdom; geometry tests replace it with a controllable observer.
import "../src/styles/index.css";
class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver;

// CodeMirror measures text ranges in animation frames; jsdom has no text layout.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

// jsdom lacks modal dialog methods; browser checks cover native focus trapping and backdrop behavior.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
