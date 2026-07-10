import { describe, expect, it } from 'vitest';
// @ts-expect-error The client tsconfig intentionally excludes Node typings, while Vitest runs in Node.
import { readFileSync } from 'node:fs';

const indexStyles = readFileSync('src/index.css', 'utf8');
const tailwindConfig = readFileSync('tailwind.config.js', 'utf8');
const secondaryActionSources = [
  'src/components/EditMessageModal.tsx',
  'src/components/MessageInputAIControls.tsx',
  'src/components/MessageInput.tsx',
].map(path => readFileSync(path, 'utf8')).join('\n');
const roomCreateSource = readFileSync('src/components/RoomCreateModal.tsx', 'utf8');
const compactSecondaryTextSources = [
  'src/components/SettingsView.tsx',
  'src/components/RoomSettingsModal.tsx',
  'src/components/CodeAgentWorkspacePanel.tsx',
  'src/components/CodeAgentWorkspaceDiffViewer.tsx',
].map(path => readFileSync(path, 'utf8')).join('\n');

const relativeLuminance = (hex: string) => {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
};

const contrastRatio = (first: string, second: string) => {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
};

describe('semantic secondary action contrast', () => {
  it('keeps base and native-hover text pairs above WCAG AA in both themes', () => {
    expect(tailwindConfig).toContain('DEFAULT: "#ad5237"');
    expect(tailwindConfig).toContain('foreground: "#faf9f5"');
    expect(tailwindConfig).toContain('DEFAULT: "#d97757"');
    expect(tailwindConfig).toContain('foreground: "#141413"');

    expect(contrastRatio('#ad5237', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#94462f', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#d97757', '#141413')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#e08a6a', '#141413')).toBeGreaterThanOrEqual(4.5);
    expect(secondaryActionSources).not.toContain('hover:bg-secondary/90');
  });

  it('overrides HeroUI opacity only for semantic secondary foreground actions', () => {
    expect(indexStyles).toContain('.bg-secondary.text-secondary-foreground[data-hover="true"]');
    expect(indexStyles).toContain('background-color: #94462f !important');
    expect(indexStyles).toContain('background-color: #e08a6a !important');
    expect(indexStyles).toContain('opacity: 1 !important');
    expect(indexStyles).not.toMatch(/(?:^|\n)\s*\[data-hover="true"\]\s*\{/);

    // With opacity locked to 1, HeroUI's data-hover state uses the same solid
    // action colors verified above instead of compositing them over the page.
    expect(contrastRatio('#94462f', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#e08a6a', '#141413')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps room-type labels and descriptions above WCAG AA in every visual state', () => {
    expect(roomCreateSource.match(/data-\[hover=true\]:!opacity-100/g)).toHaveLength(2);
    expect(roomCreateSource).not.toContain('text-xs leading-5 opacity-75');

    expect(contrastRatio('#7f3f29', '#f3d8ca')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#7f3f29', '#eac8b8')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#faf9f5', '#44271f')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#faf9f5', '#553127')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#4d4c48', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#4d4c48', '#efede5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#b0aea5', '#141413')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#b0aea5', '#282826')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps compact light-theme secondary text above WCAG AA', () => {
    expect(contrastRatio('#5e5d59', '#f5f4ed')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#5e5d59', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(compactSecondaryTextSources).not.toContain('#77756f');
    expect(compactSecondaryTextSources).not.toContain('#87867f');
  });
});
