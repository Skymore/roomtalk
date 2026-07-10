import React from 'react';
import {
  formatCompactDiffCount,
  hasNonZeroChangedFileStat,
  type CodeAgentChangedFileStat,
} from '../utils/codeAgentChangedFileTree';

export { hasNonZeroChangedFileStat };

interface CodeAgentDiffStatLabelProps extends CodeAgentChangedFileStat {
  className?: string;
  showParentheses?: boolean;
  layout?: 'aligned' | 'inline';
}

export const CodeAgentDiffStatLabel = React.memo(function CodeAgentDiffStatLabel({
  additions,
  deletions,
  className = '',
  showParentheses = false,
  layout = 'aligned',
}: CodeAgentDiffStatLabelProps) {
  return (
    <>
      {showParentheses ? <span className="text-[#5e5d59]/70 dark:text-[#8f8d86]/70">(</span> : null}
      <span
        className={`${
          layout === 'inline'
            ? 'inline-flex items-center gap-1 tabular-nums align-middle'
            : 'inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle'
        } ${className}`}
      >
        <span className="font-mono text-[#2f6f4e] dark:text-[#65d08a]">+{formatCompactDiffCount(additions)}</span>
        <span className="font-mono text-[#9f462c] dark:text-[#ff9b78]">-{formatCompactDiffCount(deletions)}</span>
      </span>
      {showParentheses ? <span className="text-[#5e5d59]/70 dark:text-[#8f8d86]/70">)</span> : null}
    </>
  );
});
