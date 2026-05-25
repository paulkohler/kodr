import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, parseArgs, usage, VERSION } from '../src/app.mjs';

describe('parseArgs', () => {
  it('starts with LM Studio-friendly defaults', () => {
    const options = parseArgs([], {});

    assert.equal(options.baseUrl, 'http://localhost:1234/v1');
    assert.equal(options.timeoutMs, 600000);
  });

  it('parses model endpoint flags', () => {
    const options = parseArgs([
      '--base-url',
      'http://localhost:1234/v1/',
      '--model',
      'nvidia/nemotron-3-nano-omni',
      '--timeout-ms',
      '1000'
    ]);

    assert.equal(options.baseUrl, 'http://localhost:1234/v1');
    assert.equal(options.model, 'nvidia/nemotron-3-nano-omni');
    assert.equal(options.timeoutMs, 1000);
  });

  it('rejects unknown options', () => {
    assert.throws(() => parseArgs(['--wat']), CliError);
  });
});

describe('usage', () => {
  it('mentions the current version and planned commands', () => {
    const text = usage();

    assert.match(text, new RegExp(VERSION));
    assert.match(text, /koder probe/u);
  });
});
