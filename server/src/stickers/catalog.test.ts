import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getSticker,
  getStickerCatalog,
  isValidStickerId,
  loadStickerCatalog,
  StickerCatalog,
} from './catalog';

const FIXTURE: StickerCatalog = {
  version: 1,
  packs: [
    { id: 'xiaokumao', name: '小哭猫', cover: 'xiaokumao/001/01', stickerIds: ['xiaokumao/001/01', 'xiaokumao/001/02'] },
  ],
  stickers: {
    'xiaokumao/001/01': { id: 'xiaokumao/001/01', url: 'https://cdn.test/stickers/xiaokumao/001/01.jpg', pack: 'xiaokumao', keywords: ['我的优点是什么呢'], width: 1080, height: 1080 },
    'xiaokumao/001/02': { id: 'xiaokumao/001/02', url: 'https://cdn.test/stickers/xiaokumao/001/02.jpg', pack: 'xiaokumao', keywords: ['开心'] },
  },
};

const writeFixture = (catalog: unknown): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-cat-')), 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  process.env.STICKER_CATALOG_PATH = file;
  return file;
};

afterEach(() => {
  delete process.env.STICKER_CATALOG_PATH;
});

describe('sticker catalog', () => {
  it('loads a catalog from STICKER_CATALOG_PATH', () => {
    writeFixture(FIXTURE);
    const catalog = loadStickerCatalog();
    assert.equal(catalog.version, 1);
    assert.equal(catalog.packs.length, 1);
    assert.equal(Object.keys(catalog.stickers).length, 2);
    assert.deepEqual(getStickerCatalog(), catalog);
  });

  it('validates known stickerIds and rejects unknown/non-string', () => {
    writeFixture(FIXTURE);
    loadStickerCatalog();
    assert.equal(isValidStickerId('xiaokumao/001/01'), true);
    assert.equal(isValidStickerId('xiaokumao/999/99'), false);
    assert.equal(isValidStickerId(''), false);
    assert.equal(isValidStickerId(undefined), false);
    assert.equal(isValidStickerId(123 as unknown), false);
  });

  it('resolves a sticker definition by id', () => {
    writeFixture(FIXTURE);
    loadStickerCatalog();
    assert.equal(getSticker('xiaokumao/001/01')?.url, 'https://cdn.test/stickers/xiaokumao/001/01.jpg');
    assert.equal(getSticker('nope'), undefined);
  });

  it('degrades to an empty catalog when the file is missing or malformed', () => {
    process.env.STICKER_CATALOG_PATH = path.join(os.tmpdir(), 'does-not-exist-xyz', 'catalog.json');
    const catalog = loadStickerCatalog();
    assert.equal(catalog.version, 0);
    assert.equal(Object.keys(catalog.stickers).length, 0);
    assert.equal(isValidStickerId('xiaokumao/001/01'), false);

    const badFile = writeFixture('not-an-object');
    assert.ok(badFile);
    const empty = loadStickerCatalog();
    assert.equal(empty.version, 0);
    assert.equal(empty.packs.length, 0);
  });
});
