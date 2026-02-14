import { useState, useCallback, useRef } from "react";

const EXIT_WINDOW_MS = 2000;

export function useDoubleCtrlC(onExit: () => void) {
  const [showExitHint, setShowExitHint] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPressRef = useRef(false);

  const handleCtrlC = useCallback(
    (isStreaming: boolean, onAbort: () => void) => {
      if (isStreaming) {
        onAbort();
        return;
      }

      if (firstPressRef.current) {
        // Second press within window — exit
        if (timerRef.current) clearTimeout(timerRef.current);
        firstPressRef.current = false;
        setShowExitHint(false);
        onExit();
        return;
      }

      // First press — show hint, start timer
      firstPressRef.current = true;
      setShowExitHint(true);

      timerRef.current = setTimeout(() => {
        firstPressRef.current = false;
        setShowExitHint(false);
        timerRef.current = null;
      }, EXIT_WINDOW_MS);
    },
    [onExit],
  );

  return { handleCtrlC, showExitHint };
}
