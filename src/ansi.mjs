const ANSI_PATTERN = /\u001B\[[0-9;]*m/gu;

const CODES = {
	bold: ['\u001B[1m', '\u001B[22m'],
	cyan: ['\u001B[36m', '\u001B[39m'],
	dim: ['\u001B[2m', '\u001B[22m'],
	gray: ['\u001B[90m', '\u001B[39m'],
	green: ['\u001B[32m', '\u001B[39m'],
	red: ['\u001B[31m', '\u001B[39m'],
	yellow: ['\u001B[33m', '\u001B[39m'],
};

export function createAnsi(options = {}) {
	const enabled = colorEnabled(options);
	const wrap = (name, text) => {
		const value = String(text);
		if (!enabled) {
			return value;
		}
		const [open, close] = CODES[name];
		return `${open}${value}${close}`;
	};

	return {
		bold: (text) => wrap('bold', text),
		cyan: (text) => wrap('cyan', text),
		dim: (text) => wrap('dim', text),
		enabled,
		gray: (text) => wrap('gray', text),
		green: (text) => wrap('green', text),
		red: (text) => wrap('red', text),
		yellow: (text) => wrap('yellow', text),
	};
}

export function stripAnsi(text) {
	return String(text).replace(ANSI_PATTERN, '');
}

function colorEnabled(options) {
	const env = options.env || {};
	if (Object.hasOwn(env, 'NO_COLOR')) {
		return false;
	}
	if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') {
		return true;
	}
	return options.isTty === true;
}
