// Wrapper script to monitor npm execution and log what's happening
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '.cursor', 'debug.log');
const SERVER_ENDPOINT = 'http://127.0.0.1:7244/ingest/1163e1f9-5b04-46b2-9013-44e33e9d5de9';

function log(entry) {
	const logLine = JSON.stringify({
		...entry,
		timestamp: Date.now(),
		sessionId: 'debug-session',
		runId: process.env.RUN_ID || 'run1'
	}) + '\n';
	
	try {
		fs.appendFileSync(LOG_PATH, logLine, 'utf8');
	} catch (err) {
		console.error('Failed to write log:', err);
	}
	
	// Also try HTTP (async, don't block)
	const http = require('http');
	const url = require('url');
	const parsedUrl = url.parse(SERVER_ENDPOINT);
	const postData = JSON.stringify(entry);
	const options = {
		hostname: parsedUrl.hostname,
		port: parsedUrl.port,
		path: parsedUrl.path,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
	};
	const req = http.request(options, () => {}).on('error', () => {});
	req.write(postData);
	req.end();
}

const command = process.argv[2] || 'install';
const args = process.argv.slice(3);

log({
	location: 'npm-wrapper.js:start',
	message: 'npm wrapper started',
	data: { command, args, nodeVersion: process.version, cwd: process.cwd() },
	hypothesisId: 'A'
});

const npmProcess = spawn('npm', [command, ...args], {
	stdio: ['inherit', 'pipe', 'pipe'],
	shell: true
});

let stdout = '';
let stderr = '';

npmProcess.stdout.on('data', (data) => {
	const chunk = data.toString();
	stdout += chunk;
	log({
		location: 'npm-wrapper.js:stdout',
		message: 'npm stdout chunk',
		data: { chunkLength: chunk.length, totalStdoutLength: stdout.length },
		hypothesisId: 'B'
	});
	process.stdout.write(data);
});

npmProcess.stderr.on('data', (data) => {
	const chunk = data.toString();
	stderr += chunk;
	log({
		location: 'npm-wrapper.js:stderr',
		message: 'npm stderr chunk',
		data: { chunkLength: chunk.length, totalStderrLength: stderr.length },
		hypothesisId: 'C'
	});
	process.stderr.write(data);
});

npmProcess.on('spawn', () => {
	log({
		location: 'npm-wrapper.js:spawn',
		message: 'npm process spawned',
		data: { pid: npmProcess.pid },
		hypothesisId: 'A'
	});
});

npmProcess.on('error', (error) => {
	log({
		location: 'npm-wrapper.js:error',
		message: 'npm process error',
		data: { error: error.message, code: error.code },
		hypothesisId: 'D'
	});
});

npmProcess.on('exit', (code, signal) => {
	log({
		location: 'npm-wrapper.js:exit',
		message: 'npm process exited',
		data: { code, signal, stdoutLength: stdout.length, stderrLength: stderr.length },
		hypothesisId: 'E'
	});
	process.exit(code || 0);
});

// Monitor memory usage
const memoryInterval = setInterval(() => {
	const memUsage = process.memoryUsage();
	log({
		location: 'npm-wrapper.js:memory',
		message: 'memory usage check',
		data: {
			rss: Math.round(memUsage.rss / 1024 / 1024),
			heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
			heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024)
		},
		hypothesisId: 'F'
	});
}, 5000);

npmProcess.on('exit', () => {
	clearInterval(memoryInterval);
});

