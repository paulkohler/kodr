import { isAbsolute } from 'node:path';

export class PermissionPolicyError extends Error {
	constructor(message) {
		super(message);
		this.name = 'PermissionPolicyError';
	}
}

export class PermissionPolicy {
	constructor(options = {}) {
		this.allowApply = options.allowApply !== false;
		this.allowNetwork = options.allowNetwork !== false;
		this.allowReads = options.allowReads !== false;
		this.allowWrites = options.allowWrites !== false;
		this.allowedCommands = options.allowedCommands || null;
		this.allowedNetworkHosts = options.allowedNetworkHosts || null;
		this.allowedReadPaths = options.allowedReadPaths || [''];
		this.allowedWritePaths = options.allowedWritePaths || [''];
	}

	checkRead(path) {
		if (!this.allowReads) {
			throw new PermissionPolicyError('File reads are denied by policy');
		}
		if (isRestrictedPathSet(this.allowedReadPaths)) {
			checkRelativePath(path);
			checkAllowedPath('read', path, this.allowedReadPaths);
		}
	}

	checkWrite(path, options = {}) {
		if (!this.allowWrites) {
			throw new PermissionPolicyError('File writes are denied by policy');
		}
		if (options.apply === true && !this.allowApply) {
			throw new PermissionPolicyError('Applying writes is denied by policy');
		}
		if (isRestrictedPathSet(this.allowedWritePaths)) {
			checkRelativePath(path);
			checkAllowedPath('write', path, this.allowedWritePaths);
		}
	}

	checkCommand(command) {
		if (this.allowedCommands && !this.allowedCommands.includes(command)) {
			throw new PermissionPolicyError(
				`Command is denied by policy: ${command}`,
			);
		}
	}

	checkNetwork(url) {
		if (!this.allowNetwork) {
			throw new PermissionPolicyError('Network access is denied by policy');
		}

		if (!this.allowedNetworkHosts) {
			return;
		}

		const parsed = new URL(url);
		if (!this.allowedNetworkHosts.includes(parsed.hostname)) {
			throw new PermissionPolicyError(
				`Network host is denied by policy: ${parsed.hostname}`,
			);
		}
	}
}

export function createPermissionPolicy(options = {}) {
	if (options instanceof PermissionPolicy) {
		return options;
	}

	return new PermissionPolicy(options);
}

function checkAllowedPath(kind, path, prefixes) {
	if (prefixes.some((prefix) => pathMatchesPrefix(path, prefix))) {
		return;
	}

	throw new PermissionPolicyError(
		`Path is outside allowed ${kind} paths: ${path}`,
	);
}

function isRestrictedPathSet(prefixes) {
	return prefixes.length !== 1 || prefixes[0] !== '';
}

function pathMatchesPrefix(path, prefix) {
	if (prefix === '') {
		return true;
	}

	return path === prefix || path.startsWith(`${prefix}/`);
}

function checkRelativePath(path) {
	if (!path || typeof path !== 'string') {
		throw new PermissionPolicyError('Path must be a non-empty string');
	}

	if (isAbsolute(path) || path.split(/[\\/]+/u).includes('..')) {
		throw new PermissionPolicyError(`Path is not workspace-relative: ${path}`);
	}
}
