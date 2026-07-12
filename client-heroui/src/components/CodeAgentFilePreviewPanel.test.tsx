import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBrowserAssetPreview } from './CodeAgentFilePreviewPanel';

describe('WorkspaceBrowserAssetPreview', () => {
  it('reports each iframe load or error event exactly once', () => {
    const onPreviewStatusChange = vi.fn();
    const { container } = render(
      <WorkspaceBrowserAssetPreview
        src="/api/code-agent/workspace-assets/token/report.html"
        title="report.html"
        onPreviewStatusChange={onPreviewStatusChange}
      />
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    fireEvent.load(iframe as HTMLIFrameElement);
    expect(onPreviewStatusChange).toHaveBeenCalledTimes(1);
    expect(onPreviewStatusChange.mock.calls[0][0]._tag).toBe('Success');

    fireEvent.error(iframe as HTMLIFrameElement);
    expect(onPreviewStatusChange).toHaveBeenCalledTimes(2);
    expect(onPreviewStatusChange.mock.calls[1][0]._tag).toBe('LoadFailed');
  });
});
