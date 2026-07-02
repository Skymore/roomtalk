import {
  type CodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSize,
} from './codeAgentPreviewViewport';
import { codeAgentBrowserViewportSettingKey } from './codeAgentBrowserViewportLayout';

export function isCodeWorkspacePreviewViewportReady(input: {
  readonly setting: CodeAgentPreviewViewportSetting;
  readonly appliedSettingKey: string | null;
  readonly declaredViewport: CodeAgentPreviewViewportSize | null;
  readonly renderedViewport: CodeAgentPreviewViewportSize | null;
}): boolean {
  const { setting, appliedSettingKey, declaredViewport, renderedViewport } = input;
  if (
    appliedSettingKey !== codeAgentBrowserViewportSettingKey(setting)
    || declaredViewport === null
    || renderedViewport === null
  ) {
    return false;
  }

  const expectedViewport = setting._tag === 'fill'
    ? declaredViewport
    : { width: setting.width, height: setting.height };
  if (
    setting._tag !== 'fill'
    && (
      declaredViewport.width !== expectedViewport.width
      || declaredViewport.height !== expectedViewport.height
    )
  ) {
    return false;
  }

  const tolerance = 1;
  return (
    Math.abs(renderedViewport.width - expectedViewport.width) <= tolerance
    && Math.abs(renderedViewport.height - expectedViewport.height) <= tolerance
  );
}
