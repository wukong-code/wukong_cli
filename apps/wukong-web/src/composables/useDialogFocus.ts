import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue';

/**
 * Baseline modal-dialog focus lifecycle, shared by the overlay dialogs so they
 * behave consistently:
 *
 * - records which element had focus before the dialog opened,
 * - moves focus into the dialog on open (an explicit `initialFocus` target if
 *   given, otherwise the dialog root — which should carry `tabindex="-1"`),
 * - traps Tab/Shift+Tab within the active dialog,
 * - restores focus to the opener when the dialog unmounts (i.e. closes).
 *
 * `aria-modal="true"` and Escape-to-close stay in each dialog's template/markup;
 * this composable only owns the focus in/out so that part is not re-implemented
 * (and re-forgotten) per dialog.
 */
export function useDialogFocus(
  dialogRef: Ref<HTMLElement | null>,
  initialFocus?: Ref<HTMLElement | null>,
): void {
  let previouslyFocused: HTMLElement | null = null;

  function focusableElements(): HTMLElement[] {
    const root = dialogRef.value;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const root = dialogRef.value;
    if (!root) return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  onMounted(() => {
    previouslyFocused =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.addEventListener('keydown', onKeydown, true);
    void nextTick(() => {
      const target = initialFocus?.value ?? dialogRef.value;
      try {
        target?.focus();
      } catch {
        // Non-focusable target or jsdom without focus support — ignore.
      }
    });
  });

  onBeforeUnmount(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onKeydown, true);
    }
    const el = previouslyFocused;
    previouslyFocused = null;
    if (!el || typeof document === 'undefined' || !document.contains(el)) return;
    try {
      el.focus();
    } catch {
      // ignore
    }
  });
}
