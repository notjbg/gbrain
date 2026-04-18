import { describe, test, expect } from 'bun:test';
import { validateSlug, contentHash, parsePgVector, rowToPage, rowToChunk, rowToSearchResult } from '../src/core/utils.ts';

describe('validateSlug', () => {
  test('accepts valid slugs', () => {
    expect(validateSlug('people/sarah-chen')).toBe('people/sarah-chen');
    expect(validateSlug('concepts/rag')).toBe('concepts/rag');
    expect(validateSlug('simple')).toBe('simple');
  });

  test('normalizes to lowercase', () => {
    expect(validateSlug('People/Sarah-Chen')).toBe('people/sarah-chen');
    expect(validateSlug('UPPER')).toBe('upper');
  });

  test('rejects empty slug', () => {
    expect(() => validateSlug('')).toThrow('Invalid slug');
  });

  test('rejects path traversal', () => {
    expect(() => validateSlug('../etc/passwd')).toThrow('path traversal');
    expect(() => validateSlug('test/../hack')).toThrow('path traversal');
  });

  test('rejects leading slash', () => {
    expect(() => validateSlug('/absolute/path')).toThrow('start with /');
  });
});

describe('contentHash', () => {
  test('returns deterministic hash', () => {
    const page = { title: 'Test', type: 'concept' as const, compiled_truth: 'hello', timeline: 'world' };
    const h1 = contentHash(page);
    const h2 = contentHash(page);
    expect(h1).toBe(h2);
  });

  test('changes when content changes', () => {
    const h1 = contentHash({ title: 'Test', type: 'concept' as const, compiled_truth: 'hello', timeline: 'world' });
    const h2 = contentHash({ title: 'Test', type: 'concept' as const, compiled_truth: 'hello', timeline: 'changed' });
    expect(h1).not.toBe(h2);
  });

  test('returns hex string', () => {
    const h = contentHash({ title: 'Test', type: 'concept' as const, compiled_truth: 'test', timeline: '' });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('rowToPage', () => {
  test('parses string frontmatter', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: 'body', timeline: '',
      frontmatter: '{"key":"val"}',
      content_hash: 'abc', created_at: '2024-01-01', updated_at: '2024-01-01',
    });
    expect(page.frontmatter.key).toBe('val');
  });

  test('handles object frontmatter', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: 'body', timeline: '',
      frontmatter: { key: 'val' },
      content_hash: 'abc', created_at: '2024-01-01', updated_at: '2024-01-01',
    });
    expect(page.frontmatter.key).toBe('val');
  });

  test('creates Date objects', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: '', timeline: '', frontmatter: '{}',
      content_hash: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    });
    expect(page.created_at).toBeInstanceOf(Date);
    expect(page.updated_at).toBeInstanceOf(Date);
  });
});

describe('rowToChunk', () => {
  test('nulls embedding by default', () => {
    const chunk = rowToChunk({
      id: 1, page_id: 1, chunk_index: 0, chunk_text: 'text',
      chunk_source: 'compiled_truth', embedding: new Float32Array(10),
      model: 'test', token_count: 5, embedded_at: '2024-01-01',
    });
    expect(chunk.embedding).toBeNull();
  });

  test('includes embedding when requested', () => {
    const emb = new Float32Array(10).fill(0.5);
    const chunk = rowToChunk({
      id: 1, page_id: 1, chunk_index: 0, chunk_text: 'text',
      chunk_source: 'compiled_truth', embedding: emb,
      model: 'test', token_count: 5, embedded_at: '2024-01-01',
    }, true);
    expect(chunk.embedding).not.toBeNull();
  });

  test('parses pgvector string representation into Float32Array', () => {
    const chunk = rowToChunk({
      id: 1, page_id: 1, chunk_index: 0, chunk_text: 'text',
      chunk_source: 'compiled_truth', embedding: '[0.1,-0.2,0.3]',
      model: 'test', token_count: 5, embedded_at: '2024-01-01',
    }, true);
    expect(chunk.embedding).toBeInstanceOf(Float32Array);
    expect(chunk.embedding!.length).toBe(3);
    expect(chunk.embedding![0]).toBeCloseTo(0.1);
    expect(chunk.embedding![1]).toBeCloseTo(-0.2);
    expect(chunk.embedding![2]).toBeCloseTo(0.3);
  });
});

describe('parsePgVector', () => {
  test('passes through Float32Array', () => {
    const emb = new Float32Array([0.1, 0.2, 0.3]);
    expect(parsePgVector(emb)).toBe(emb);
  });

  test('converts number array to Float32Array', () => {
    const out = parsePgVector([0.1, 0.2, 0.3]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out!.length).toBe(3);
    expect(out![0]).toBeCloseTo(0.1);
  });

  test('parses pgvector textual format', () => {
    const out = parsePgVector('[0.5,-0.25,1.0]');
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out!)).toEqual([0.5, -0.25, 1.0]);
  });

  test('parses bare comma-separated floats', () => {
    const out = parsePgVector('0.5,-0.25,1.0');
    expect(Array.from(out!)).toEqual([0.5, -0.25, 1.0]);
  });

  test('produces finite numbers (regression: cosine=NaN on hybrid re-score)', () => {
    const out = parsePgVector('[0.1,0.2,0.3]')!;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
    }
  });

  test('returns null for nullish input', () => {
    expect(parsePgVector(null)).toBeNull();
    expect(parsePgVector(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parsePgVector('')).toBeNull();
    expect(parsePgVector('[]')).toBeNull();
  });
});

describe('rowToSearchResult', () => {
  test('coerces score to number', () => {
    const r = rowToSearchResult({
      slug: 'test', page_id: 1, title: 'Test', type: 'concept',
      chunk_text: 'text', chunk_source: 'compiled_truth',
      score: '0.95', stale: false,
    });
    expect(typeof r.score).toBe('number');
    expect(r.score).toBe(0.95);
  });
});
