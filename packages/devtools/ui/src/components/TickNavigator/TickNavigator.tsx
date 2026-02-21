import type { Tick, TokenSummary } from "../../hooks/useDevToolsEvents.js";

interface TickNavigatorProps {
  ticks: Tick[];
  selectedTick: number | "latest";
  onSelectTick: (tick: number | "latest") => void;
}

/**
 * Format tokens for display.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * TickNavigator provides time-travel through execution ticks.
 * Users can scrub through the timeline to see component tree state at each tick.
 */
export function TickNavigator({ ticks, selectedTick, onSelectTick }: TickNavigatorProps) {
  const ticksWithFiber = ticks.filter((t) => t.fiberTree);

  if (ticksWithFiber.length === 0) {
    return (
      <div className="tick-navigator tick-navigator-empty">
        <span className="tick-navigator-label">Timeline</span>
        <span className="tick-navigator-empty-text">No tick snapshots</span>
      </div>
    );
  }

  // Get total tokens for the selected tick
  const getSelectedTickTokens = (): TokenSummary | undefined => {
    if (selectedTick === "latest") {
      return ticksWithFiber[ticksWithFiber.length - 1]?.tokenSummary;
    }
    return ticksWithFiber.find((t) => t.number === selectedTick)?.tokenSummary;
  };

  const tokenSummary = getSelectedTickTokens();

  return (
    <div className="tick-navigator">
      {/* Label */}
      <div className="tick-navigator-label">Timeline</div>

      {/* Latest Button */}
      <button
        className={`tick-navigator-latest ${selectedTick === "latest" ? "active" : ""}`}
        onClick={() => onSelectTick("latest")}
        title="Latest state (live)"
      >
        Latest
      </button>

      {/* Scrubber Track */}
      <div className="tick-navigator-scrubber">
        <div className="tick-navigator-rail" />
        <div
          className="tick-navigator-rail-fill"
          style={{
            width: (() => {
              if (selectedTick === "latest") return "100%";
              const idx = ticksWithFiber.findIndex((t) => t.number === selectedTick);
              if (idx === -1 || ticksWithFiber.length <= 1) return "0%";
              return `${(idx / (ticksWithFiber.length - 1)) * 100}%`;
            })(),
          }}
        />
        <div className="tick-navigator-ticks">
          {ticksWithFiber.map((t) => (
            <button
              key={t.number}
              className={`tick-navigator-tick ${selectedTick === t.number ? "active" : ""}`}
              onClick={() => onSelectTick(t.number)}
              title={`Tick ${t.number}${t.fiberSummary ? ` - ${t.fiberSummary.componentCount} components` : ""}${t.tokenSummary ? ` - ~${formatTokens(t.tokenSummary.total)} tokens` : ""}`}
              style={{
                opacity:
                  selectedTick === "latest" ||
                  (typeof selectedTick === "number" && t.number <= selectedTick)
                    ? 1
                    : 0.5,
              }}
            >
              <span className="tick-navigator-tick-label">Tick {t.number}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Info Panel */}
      <div className="tick-navigator-info">
        <span className="tick-navigator-current">
          {selectedTick === "latest" ? "Latest" : `Tick ${selectedTick}`}
        </span>
        {tokenSummary && (
          <span className="tick-navigator-tokens">~{formatTokens(tokenSummary.total)}</span>
        )}
      </div>

      {/* Controls */}
      <div className="tick-navigator-controls">
        <button
          className="tick-navigator-btn"
          onClick={() => onSelectTick(ticksWithFiber[0].number)}
          disabled={selectedTick === ticksWithFiber[0].number}
          title="First tick"
        >
          |◀
        </button>
        <button
          className="tick-navigator-btn"
          onClick={() => {
            const currentIdx =
              selectedTick === "latest"
                ? ticksWithFiber.length - 1
                : ticksWithFiber.findIndex((t) => t.number === selectedTick);
            if (currentIdx > 0) {
              onSelectTick(ticksWithFiber[currentIdx - 1].number);
            }
          }}
          disabled={
            selectedTick === ticksWithFiber[0].number ||
            (selectedTick !== "latest" &&
              ticksWithFiber.findIndex((t) => t.number === selectedTick) === 0)
          }
          title="Previous tick"
        >
          ◀
        </button>
        <button
          className="tick-navigator-btn"
          onClick={() => {
            const currentIdx =
              selectedTick === "latest"
                ? ticksWithFiber.length
                : ticksWithFiber.findIndex((t) => t.number === selectedTick);
            if (currentIdx < ticksWithFiber.length - 1) {
              onSelectTick(ticksWithFiber[currentIdx + 1].number);
            } else {
              onSelectTick("latest");
            }
          }}
          disabled={selectedTick === "latest"}
          title="Next tick"
        >
          ▶
        </button>
        <button
          className="tick-navigator-btn"
          onClick={() => onSelectTick("latest")}
          disabled={selectedTick === "latest"}
          title="Latest"
        >
          ▶|
        </button>
      </div>
    </div>
  );
}
