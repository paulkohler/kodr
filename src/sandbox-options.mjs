// sandbox-options.mjs — pure option helpers (defaults + validators + error
// classes) for the Docker and OpenShell sandbox backends. Extracted from
// docker-executor.mjs / openshell-executor.mjs in phase 149 so that parse-time
// validation (cli/args.mjs) does not statically import the heavy executor
// modules (which pull in node:child_process and the full sandbox machinery).
// This module has no node:child_process / spawn dependency — it only reads
// option fields and throws. The executor modules import the defaults back from
// here and re-export the helpers so existing importers stay unchanged.

const DEFAULT_DOCKER_IMAGE = 'node:24-bookworm-slim';
const DEFAULT_DOCKER_WORKDIR = '/workspace';

export class DockerSandboxError extends Error {
	constructor(message) {
		super(message);
		this.name = 'DockerSandboxError';
	}
}

export class OpenShellSandboxError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'OpenShellSandboxError';
		this.details = details;
	}
}

function isAllowedNetwork(value) {
	return (
		value === 'none' ||
		value === 'bridge' ||
		/^[a-zA-Z0-9_.-]+$/u.test(value || '')
	);
}

export function dockerDefaults(options = {}) {
	return {
		dockerImage: options.dockerImage || DEFAULT_DOCKER_IMAGE,
		dockerKeep: options.dockerKeep === true,
		dockerNetwork:
			options.dockerNetwork ||
			(options.installDependencies ? 'bridge' : 'none'),
		dockerWorkdir: options.dockerWorkdir || DEFAULT_DOCKER_WORKDIR,
	};
}

export function validateDockerOptions(options = {}) {
	if (!options.dockerSandbox) {
		return;
	}
	if (!options.dockerImage || !options.dockerImage.trim()) {
		throw new DockerSandboxError('--docker-image must not be empty');
	}
	if (!options.dockerWorkdir || !options.dockerWorkdir.startsWith('/')) {
		throw new DockerSandboxError('--docker-workdir must be an absolute path');
	}
	if (!isAllowedNetwork(options.dockerNetwork)) {
		throw new DockerSandboxError(
			'--docker-network must be "none", "bridge", or a simple Docker network name',
		);
	}
}

export function openshellDefaults(options = {}) {
	return {
		openshellFrom: options.openshellFrom || '',
		openshellKeep: options.openshellKeep === true,
		openshellPolicy: options.openshellPolicy || '',
	};
}

export function validateOpenShellOptions(options = {}) {
	if (!options.openshellSandbox && !options.openshellWorker) {
		return;
	}
	if (options.dockerSandbox) {
		throw new OpenShellSandboxError(
			'--docker-sandbox cannot be used with OpenShell sandbox modes',
		);
	}
	if (options.openshellSandbox && options.openshellWorker) {
		throw new OpenShellSandboxError(
			'--openshell-sandbox and --openshell-worker cannot be used together',
		);
	}
	if (options.installDependencies && !options.openshellPolicy) {
		if (options.openshellWorker) {
			return;
		}
		throw new OpenShellSandboxError(
			'--install with --openshell-sandbox requires --openshell-policy so dependency network access is explicit',
		);
	}
}
