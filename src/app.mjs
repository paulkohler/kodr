export const VERSION = '0.0.0';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT_MS = 600000;

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

export function parseArgs(argv, env = {}) {
  const options = {
    baseUrl: env.BASE_URL || DEFAULT_BASE_URL,
    command: 'help',
    help: false,
    model: env.MODEL_ID || '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    version: false
  };

  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }

    if (arg === '--version') {
      options.version = true;
      continue;
    }

    if (arg === '--base-url' || arg === '--model' || arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError(`${arg} requires a value`);
      }
      index += 1;
      assignValue(options, arg, value);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length > 0) {
    options.command = positionals[0];
    if (positionals.length > 1) {
      throw new CliError(`Unexpected positional arguments: ${positionals.slice(1).join(' ')}`);
    }
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
    throw new CliError('--timeout-ms must be an integer greater than or equal to 100');
  }

  return options;
}

export function usage() {
  return `koder ${VERSION}

Usage:
  koder --help
  koder --version

Planned local-model defaults:
  --base-url URL       Default: ${DEFAULT_BASE_URL}
  --model ID           Default: MODEL_ID
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}

The first build phases will add:
  koder probe
  koder run -p "task"
  koder run --workflow
`;
}

export async function main(argv, io) {
  const options = parseArgs(argv, io.env);

  if (options.version) {
    io.stdout.write(`${VERSION}\n`);
    return { ok: true, command: 'version' };
  }

  if (options.help || options.command === 'help') {
    io.stdout.write(usage());
    return { ok: true, command: 'help' };
  }

  throw new CliError(`Command not implemented yet: ${options.command}`);
}

function assignValue(options, flag, value) {
  if (flag === '--base-url') {
    options.baseUrl = value.replace(/\/+$/u, '');
  } else if (flag === '--model') {
    options.model = value;
  } else if (flag === '--timeout-ms') {
    options.timeoutMs = Number(value);
  }
}
