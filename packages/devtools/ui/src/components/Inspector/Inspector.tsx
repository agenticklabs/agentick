import type { FiberNode, HookState, TokenSummary } from "../../hooks/useDevToolsEvents.js";
import { PropsSection } from "./PropsSection.js";
import { HooksSection } from "./HooksSection.js";
import { TokenSection } from "./TokenSection.js";

interface InspectorProps {
  node: FiberNode | null;
  tokenSummary?: TokenSummary;
}

export function Inspector({ node, tokenSummary }: InspectorProps) {
  if (!node) {
    return (
      <div className="inspector-empty">
        <div className="inspector-empty-icon">&#128269;</div>
        <div className="inspector-empty-title">Select a component</div>
        <div className="inspector-empty-text">Click on a component in the tree to inspect it</div>
      </div>
    );
  }

  const hasHooks = node.hooks.length > 0;
  const hasProps = Object.keys(node.props).length > 0;

  return (
    <div className="inspector">
      <div className="inspector-header">
        <h3 className="inspector-title">&lt;{node.type}&gt;</h3>
        {node.key && <span className="inspector-key">key="{node.key}"</span>}
      </div>

      {node._summary && (
        <div className="inspector-summary">
          <span className="inspector-summary-label">Summary:</span>
          <span className="inspector-summary-value">{node._summary}</span>
        </div>
      )}

      {/* Props Section */}
      {hasProps && <PropsSection props={node.props} />}

      {/* Hooks Section */}
      {hasHooks && <HooksSection hooks={node.hooks} />}

      {/* Token Section */}
      {tokenSummary && <TokenSection tokenSummary={tokenSummary} />}
    </div>
  );
}
