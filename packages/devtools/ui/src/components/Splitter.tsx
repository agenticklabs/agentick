import { useRef, useCallback, useEffect } from "react";

interface SplitterProps {
  /** Direction of the split */
  direction?: "horizontal" | "vertical";
  /** Called when dragging with the delta in pixels */
  onResize: (delta: number) => void;
  /** Called when drag starts */
  onResizeStart?: () => void;
  /** Called when drag ends */
  onResizeEnd?: () => void;
}

/**
 * A draggable splitter bar for resizing adjacent panels.
 * Place between two elements in a flex container.
 */
export function Splitter({
  direction = "horizontal",
  onResize,
  onResizeStart,
  onResizeEnd,
}: SplitterProps) {
  const splitterRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      onResizeStart?.();
    },
    [direction, onResizeStart],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;
      startPos.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeEnd?.();
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [direction, onResize, onResizeEnd]);

  return (
    <div
      ref={splitterRef}
      className={`splitter splitter-${direction}`}
      onMouseDown={handleMouseDown}
    />
  );
}
