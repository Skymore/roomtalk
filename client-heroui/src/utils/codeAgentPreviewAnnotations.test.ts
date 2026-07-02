import { describe, expect, it } from 'vitest';
import {
  buildCodeAgentPreviewAnnotationPrompt,
  compactCodeAgentPreviewAnnotation,
  isCodeAgentPreviewAnnotationContext,
  type CodeAgentPreviewAnnotationContext,
} from './codeAgentPreviewAnnotations';

function annotation(overrides: Partial<CodeAgentPreviewAnnotationContext> = {}): CodeAgentPreviewAnnotationContext {
  return {
    id: 'annotation-1',
    pageUrl: 'https://example.com/app',
    pageTitle: 'Preview app',
    comment: 'Make the save button primary',
    elements: [{
      id: 'element-1',
      element: {
        pageUrl: 'https://example.com/app',
        pageTitle: 'Preview app',
        tagName: 'button',
        selector: '#save',
        htmlPreview: '<button id="save">Save</button>',
        componentName: 'SaveButton',
        source: {
          functionName: 'SaveButton',
          fileName: 'src/SaveButton.tsx',
          lineNumber: 12,
          columnNumber: 4,
        },
        stack: [],
        styles: 'color: black;',
        pickedAt: '2026-07-02T00:00:00.000Z',
      },
      rect: { x: 12, y: 16, width: 96, height: 32 },
    }],
    regions: [{
      id: 'region-1',
      rect: { x: 8, y: 10, width: 140, height: 48 },
    }],
    strokes: [{
      id: 'stroke-1',
      color: '#c96442',
      width: 3,
      points: [{ x: 10, y: 10 }, { x: 30, y: 24 }],
      bounds: { x: 10, y: 10, width: 20, height: 14 },
    }],
    styleChanges: [{
      targetId: 'element-1',
      selector: '#save',
      property: 'color',
      previousValue: 'black',
      value: 'red',
    }],
    screenshot: {
      dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
      width: 320,
      height: 180,
      cropRect: { x: 0, y: 0, width: 320, height: 180 },
    },
    createdAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('codeAgentPreviewAnnotations', () => {
  it('accepts cloud preview annotation targets beyond a single picked element', () => {
    const value = annotation();

    expect(isCodeAgentPreviewAnnotationContext(value)).toBe(true);
    expect(compactCodeAgentPreviewAnnotation(value)).toMatchObject({
      regions: value.regions,
      strokes: value.strokes,
      styleChanges: value.styleChanges,
      screenshot: null,
    });
  });

  it('builds a prompt with targets, visual changes, screenshot note, and element context', () => {
    const prompt = buildCodeAgentPreviewAnnotationPrompt(annotation());

    expect(prompt).toContain('<preview_annotation>');
    expect(prompt).toContain('Comment: Make the save button primary');
    expect(prompt).toContain('Targets: 1 selected element, 1 marked region, 1 drawing.');
    expect(prompt).toContain('Requested visual changes:');
    expect(prompt).toContain('- color: black -> red');
    expect(prompt).toContain('The attached screenshot is the annotated preview crop.');
    expect(prompt).toContain('<element_context>');
    expect(prompt).toContain('selector: #save');
    expect(prompt).toContain('<button id="save">Save</button>');
  });
});
